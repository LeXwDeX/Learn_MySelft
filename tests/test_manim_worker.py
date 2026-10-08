import sys
from pathlib import Path
import unittest
sys.path.insert(0,str(Path(__file__).resolve().parents[1]/'study-assistant'))
from manim_worker import PRELUDE, check_hold_frames

class ShearBasisInputTests(unittest.TestCase):
    def setUp(self):
        import types
        from unittest.mock import Mock, patch
        # Only test rejection before graphics creation. Real Manim rendering is
        # a separate runtime check, not represented by this minimal Scene.
        module = types.ModuleType('manimlib')
        module.Scene = type('Scene', (), {})
        self.graphics = Mock(side_effect=RuntimeError('graphics boundary'))
        module.Dot = self.graphics
        self.module_patch = patch.dict(sys.modules, {'manimlib': module})
        self.module_patch.start(); self.addCleanup(self.module_patch.stop)
        namespace = {}
        exec(PRELUDE, namespace)
        self.scene = namespace['TeachingScene']()
        self.scene.mobjects = []
        self.scene.step_records = []
        self.scene.time = 0

    def test_invalid_parameters_fail_before_any_graphics_or_steps(self):
        for value in (True, False, None, '1', [], 0, -1, 10**400, 0.499, 1.501,
                      float('nan'), float('inf'), float('-inf'), 1.0001):
            with self.subTest(value=value), self.assertRaises(ValueError):
                self.scene.shear_basis(value)
        self.graphics.assert_not_called()
        self.assertEqual(self.scene.step_records, [])

    def test_supported_bounds_and_decimals_reach_the_graphics_boundary(self):
        for value in (0.5, 1, 1.0, 1.5, 0.501, 1.001, 1.499):
            with self.subTest(value=value), self.assertRaisesRegex(RuntimeError, 'graphics boundary'):
                self.scene.shear_basis(value)
        self.assertEqual(self.graphics.call_count, 7)

    def test_existing_content_steps_or_elapsed_time_are_rejected(self):
        for field, value in (('mobjects', [object()]), ('step_records', [{}]), ('time', 0.1)):
            original = getattr(self.scene, field)
            setattr(self.scene, field, value)
            with self.subTest(field=field), self.assertRaisesRegex(ValueError, 'new empty scene'):
                self.scene.shear_basis()
            setattr(self.scene, field, original)
        self.graphics.assert_not_called()

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
    def test_review_samples_motion_not_three_copies_of_result(self):
        import shutil,subprocess,tempfile
        from manim_worker import step_review_frames
        from manim_renderer import review_png
        if not shutil.which('ffmpeg'):self.skipTest('FFmpeg is required for real media sampling')
        colors=[(255,0,0)]*10+[(0,255,0)]*20+[(0,0,255)]*30
        with tempfile.TemporaryDirectory() as directory:
            output=Path(directory);video=output/'motion.mp4'
            subprocess.run(['ffmpeg','-threads','1','-filter_threads','1','-v','error','-f','rawvideo',
                '-pix_fmt','rgb24','-s','320x180','-r','30','-i','-','-c:v','libx264','-pix_fmt','yuv420p','-y',str(video)],
                input=b''.join(bytes(color)*(320*180) for color in colors),check=True,timeout=30)
            bundle=step_review_frames(video,{'start_frame':0,'hold_start_frame':39,'result_frame':59},output,0)
            for name,channel in (('start',0),('middle',1),('result',2)):
                review_png(bundle[name])
                decoded=subprocess.run(['ffmpeg','-v','error','-i','-','-f','rawvideo','-pix_fmt','rgb24','-'],
                    input=bundle[name],stdout=subprocess.PIPE,check=True,timeout=30).stdout
                center=decoded[(67*240+120)*3:(67*240+120)*3+3]
                self.assertGreater(center[channel],240)
                self.assertTrue(all(value<10 for index,value in enumerate(center) if index!=channel))

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
