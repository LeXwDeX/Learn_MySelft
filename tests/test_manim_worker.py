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
