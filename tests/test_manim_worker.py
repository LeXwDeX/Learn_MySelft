import sys
from pathlib import Path
import unittest
sys.path.insert(0,str(Path(__file__).resolve().parents[1]/'study-assistant'))
from manim_worker import check_hold_frames

class HoldFrameTests(unittest.TestCase):
    def test_decoded_static_hold_and_small_compression_noise(self):
        frame=bytes([100])*(160*90)
        manifest={'steps':[{'start_frame':0,'hold_start_frame':1,'end_frame':22}]}
        check_hold_frames(bytes([0])*(160*90)+frame*21,manifest)
        noise=bytearray(frame);noise[10]=101
        check_hold_frames(bytes([0])*(160*90)+frame+bytes(noise)*20,manifest)
    def test_motion_and_truncated_frames_are_rejected(self):
        frame=bytes([100])*(160*90)
        manifest={'steps':[{'start_frame':0,'hold_start_frame':1,'end_frame':22}]}
        for pixels in (frame*20,bytes([0])*(160*90)+frame+bytes([120])*(160*90*20),frame*22):
            with self.assertRaises(ValueError):check_hold_frames(pixels,manifest)

class MobileFrameTests(unittest.TestCase):
    def test_actual_ffmpeg_scale_keeps_result_pixels(self):
        import shutil,subprocess,tempfile,struct,zlib
        from manim_worker import mobile_review_frame
        from manim_renderer import review_png
        if not shutil.which('ffmpeg'):self.skipTest('FFmpeg is required for real media scaling')
        def chunk(kind,data):
            return struct.pack('>I',len(data))+kind+data+struct.pack('>I',zlib.crc32(kind+data)&0xffffffff)
        row=b'\0'+b'\xff\0\0'*640+b'\0\0\xff'*640
        source=b'\x89PNG\r\n\x1a\n'+chunk(b'IHDR',struct.pack('>IIBBBBB',1280,720,8,2,0,0,0))+chunk(b'IDAT',zlib.compress(row*720))+chunk(b'IEND',b'')
        with tempfile.TemporaryDirectory() as directory:
            result=Path(directory)/'result.png';result.write_bytes(source)
            target=Path(directory)/'review.png'
            mobile_review_frame(result,target)
            review_png(target.read_bytes())
            decoded=subprocess.check_output(['ffmpeg','-v','error','-i',str(target),'-f','rawvideo','-pix_fmt','rgb24','-'])
            self.assertEqual(len(decoded),240*135*3)
            left=decoded[(67*240+30)*3:(67*240+30)*3+3]
            right=decoded[(67*240+210)*3:(67*240+210)*3+3]
            self.assertGreater(left[0],240);self.assertLess(left[2],10)
            self.assertGreater(right[2],240);self.assertLess(right[0],10)
