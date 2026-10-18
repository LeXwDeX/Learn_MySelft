"""Offline paired backup keeps document references and private Manim files together."""
import fcntl
import json
import os
from pathlib import Path
import shutil
import stat
import sys
import tempfile
import unittest
from unittest.mock import patch
sys.path.insert(0,str(Path(__file__).resolve().parents[1]/'study-assistant'))
from backup_state import backup
from state_store import StateStore


class BackupStateTests(unittest.TestCase):
    def setUp(self):
        self.temp=tempfile.TemporaryDirectory();self.addCleanup(self.temp.cleanup)
        self.root=Path(self.temp.name);self.state=self.root/'state';self.destination=self.root/'backup'
        self.store=StateStore(self.state)
        self.asset_id='a'*32;self.key='u1/learn-path-v1-backup'
        self.notes='```learn-manim\n'+json.dumps({'version':1,'asset_id':self.asset_id,'title':'角','summary':'观察'})+'\n```'
        self.document={'plan':{'nodes':[{'id':'n1'}]},'nodeDetail':{'n1':{'study_notes':self.notes}}}
        self.store.put(self.key,json.dumps(self.document))
        self.accounts=Path(str(self.state)+'-accounts');self.accounts.mkdir()
        (self.accounts/'accounts.json').write_text(json.dumps({'users':[{'id':'u1','username':'offline-test'}]}))
    def assets(self):
        directory=self.state/'manim-assets'/'u1'/self.asset_id;directory.mkdir(parents=True)
        files={'video.mp4':bytes(range(256))*8192,'poster.png':b'poster','step-0.png':b'step',
               'scene.py':b'class LessonScene(TeachingScene): pass',
               'manifest':json.dumps({'version':1,'asset_id':self.asset_id,'steps':[{}]}).encode(),
               'metadata.json':json.dumps({'owner':'u1','key':self.key,'node_id':'n1','published':True}).encode()}
        for name,value in files.items():(directory/name).write_bytes(value)
        runtime={'image':'sha256:'+'b'*64};(self.state/'manim-runtime.json').write_text(json.dumps(runtime))
        manimgx_runtime={'image':'sha256:'+'c'*64};(self.state/'manimgx-runtime.json').write_text(json.dumps(manimgx_runtime))
        return directory,files,runtime,manimgx_runtime
    def test_paired_bytes_permissions_and_offline_restore(self):
        directory,files,runtime,manimgx_runtime=self.assets()
        manifest=backup(self.state,self.destination)
        self.assertEqual(manifest['manim_assets'],{'present':True,'files':len(files),'bytes':sum(map(len,files.values()))})
        self.assertTrue(manifest['manim_runtime'])
        self.assertTrue(manifest['manimgx_runtime'])
        for name,value in files.items():
            self.assertEqual((self.destination/'manim-assets'/'u1'/self.asset_id/name).read_bytes(),value)
        self.assertEqual(json.loads((self.destination/'manim-runtime.json').read_text()),runtime)
        self.assertEqual(json.loads((self.destination/'manimgx-runtime.json').read_text()),manimgx_runtime)
        for path in [self.destination,*self.destination.rglob('*')]:
            self.assertEqual(stat.S_IMODE(path.stat().st_mode),0o700 if path.is_dir() else 0o600)
        restored=self.root/'restored';restored.mkdir()
        shutil.copyfile(self.destination/'state.sqlite3',restored/'state.sqlite3')
        shutil.copytree(self.destination/'accounts',Path(str(restored)+'-accounts'))
        shutil.copytree(self.destination/'manim-assets',restored/'manim-assets')
        shutil.copyfile(self.destination/'manim-runtime.json',restored/'manim-runtime.json')
        shutil.copyfile(self.destination/'manimgx-runtime.json',restored/'manimgx-runtime.json')
        store=StateStore(restored)
        self.assertEqual(store.check(),'ok')
        self.assertEqual(json.loads(store.record(self.key)['value']),self.document)
        metadata=json.loads((restored/'manim-assets'/'u1'/self.asset_id/'metadata.json').read_text())
        users=json.loads((Path(str(restored)+'-accounts')/'accounts.json').read_text())['users']
        self.assertEqual(metadata['owner'],users[0]['id'])
        self.assertEqual(metadata['key'],self.key)
        self.assertEqual((restored/'manim-assets'/'u1'/self.asset_id/'video.mp4').read_bytes(),files['video.mp4'])
    def test_old_state_without_assets_is_supported(self):
        manifest=backup(self.state,self.destination)
        self.assertEqual(manifest['manim_assets']['present'],False)
        self.assertFalse(manifest['manim_runtime'])
        self.assertFalse(manifest['manimgx_runtime'])
        self.assertTrue((self.destination/'accounts'/'accounts.json').exists())
    def test_live_writer_is_rejected_before_destination_creation(self):
        with (self.state/'.writer.lock').open('a') as lock:
            fcntl.flock(lock,fcntl.LOCK_EX|fcntl.LOCK_NB)
            with self.assertRaisesRegex(ValueError,'stop the backend'):backup(self.state,self.destination)
        self.assertFalse(self.destination.exists())
    def test_links_and_special_files_fail_without_success_manifest(self):
        directory,_,_,_=self.assets()
        for kind in ('file-link','directory-link','hard-link','fifo','runtime-link','manimgx-runtime-link','account-link'):
            with self.subTest(kind=kind):
                external=self.root/'external';external.write_bytes(b'outside')
                bad=directory/'bad'
                if kind=='file-link':bad.symlink_to(external)
                elif kind=='directory-link':bad.symlink_to(self.root,target_is_directory=True)
                elif kind=='hard-link':os.link(external,bad)
                elif kind=='fifo':os.mkfifo(bad)
                elif kind=='runtime-link':
                    bad=self.state/'manim-runtime.json';bad.unlink();bad.symlink_to(external)
                elif kind=='manimgx-runtime-link':
                    bad=self.state/'manimgx-runtime.json';bad.unlink();bad.symlink_to(external)
                else:bad=self.accounts/'bad';bad.symlink_to(external)
                target=self.root/('bad-backup-'+kind)
                with self.assertRaises((OSError,ValueError)):backup(self.state,target)
                self.assertFalse((target/'manifest.json').exists())
                bad.unlink()
                if kind=='runtime-link':bad.write_text('{}')
                if kind=='manimgx-runtime-link':bad.write_text('{}')
    def test_copy_failure_never_leaves_success_marker(self):
        self.assets()
        with patch('backup_state._ordinary_file',side_effect=OSError('copy failed')):
            with self.assertRaises(OSError):backup(self.state,self.destination)
        self.assertFalse((self.destination/'manifest.json').exists())
    def test_destination_cannot_be_inside_sources(self):
        for destination in (self.state/'backup',self.accounts/'backup'):
            with self.assertRaisesRegex(ValueError,'outside'):backup(self.state,destination)
