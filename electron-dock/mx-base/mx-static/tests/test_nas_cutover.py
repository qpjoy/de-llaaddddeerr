"""Real local file/rsync fixtures and mocked production command/state transitions."""
import contextlib
import copy
import io
import json
import os
from pathlib import Path
import shutil
import stat
import subprocess
import sys
import tempfile
import unittest
from unittest.mock import patch

ROOT = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(ROOT/'scripts/nas'))
import cutover as cut
import cutover_prepare as prep
from verify import Report, inventory


def consumers(nas=False):
    result = {}
    for name in prep.SERVICES:
        mounts = [{'Type':'volume', 'Name':prep.VOLUME, 'Source':'/data/docker/volumes/'+prep.VOLUME+'/_data',
                   'Destination':'/app/media', 'RW':name != 'gateway'}]
        if nas: mounts.append({'Type':'volume', 'Name':prep.NFS_VOLUME,
            'Source':'/data/docker/volumes/'+prep.NFS_VOLUME+'/_data', 'Destination':cut.RAW, 'RW':name != 'gateway'})
        env = ['KEEP_SECRET=private']
        if nas and name.startswith('worker'): env += ['MX_RECOVER_STALE_AGENT_RUNS=0']
        result[name] = {'Id': ('new-' if nas else '')+name, 'Image':'sha256:old', 'Mounts':mounts,
            'Config':{'Env':env, 'Cmd':['original'], 'Entrypoint':None, 'User':'',
                      'Labels':{'com.docker.compose.project':'mx_data','com.docker.compose.service':name}},
            'HostConfig':{'RestartPolicy':{'Name':'unless-stopped'},
                          'Mounts':[{'Target':cut.RAW,'VolumeOptions':{'NoCopy':True}}] if nas else []},
            'State':{'Running':False,'ExitCode':0,'StartedAt':'0001-01-01T00:00:00Z'}}
    return result


class CutoverTests(unittest.TestCase):
    def bare(self):
        obj = cut.Cutover.__new__(cut.Cutover)
        obj.path = '/report'; obj.output = 1
        obj.state = {'schema':1, 'nas_may_have_writes':False, 'databases':{}, 'reclaim_ready':False}
        obj.old = consumers(); obj.overlay = prep.candidate(obj.old)
        obj.saved = {'precopy_state':{'job_id':'f'*32}}
        return obj

    def test_only_registered_report_paths_and_cli_modes(self):
        for path in ('/tmp/report', cut.ROOT+'/../x', cut.ROOT+'/po_infra_media_data-not-a-uuid'):
            with self.assertRaises(RuntimeError): cut.open_report(path)
        for args in (['--delete','/report'],['--cutover','/report','--force'],['--restore','/report']):
            result = subprocess.run(['bash', str(ROOT/'scripts/nas-cutover.sh')]+args, capture_output=True)
            self.assertEqual(result.returncode, 2)

    def test_create_command_does_not_touch_dependencies_pull_build_or_start(self):
        command = cut.create_command('/report', 'compose.nas.override.json')
        self.assertEqual(set(command[-10:]), prep.SERVICES)
        for flag in ('--no-deps','--no-build','--no-start','--remove-orphans=false'): self.assertIn(flag, command)
        self.assertEqual(command[command.index('--pull')+1], 'never')
        self.assertNotIn('down', command)
        self.assertNotIn('--renew-anon-volumes', command)
        with patch.object(cut, 'descriptor_path', side_effect=lambda fd: '/fd/'+str(fd)):
            quick = cut.quick_command(3,4)
        self.assertIn('--delete', quick); self.assertIn('--dry-run', quick)
        self.assertNotIn('--checksum', quick)

    def test_ssd_overlay_preserves_startup_safety_and_image_pins(self):
        overlay = prep.candidate(consumers())
        restored = cut.rollback_overlay(overlay)
        self.assertNotIn('volumes', restored)
        self.assertEqual(restored['services']['web']['command'][0], 'gunicorn')
        for name, service in restored['services'].items():
            self.assertNotIn('volumes', service)
            self.assertEqual(service['image'], 'sha256:old')
            if name.startswith('worker'): self.assertEqual(service['environment']['MX_RECOVER_STALE_AGENT_RUNS'], '0')
        self.assertIn('volumes', overlay)  # Original candidate remains unchanged.

    def test_drain_has_no_forced_timeout_and_only_media_ids(self):
        obj = self.bare()
        with patch.object(obj, 'command') as command, contextlib.redirect_stdout(io.StringIO()):
            obj.stop(obj.old)
        self.assertEqual(len(command.call_args_list), 3)
        seen = []
        for call in command.call_args_list:
            self.assertEqual(call.args[0][:4], ['docker','stop','-t','-1'])
            self.assertIsNone(call.kwargs['timeout']); seen += call.args[0][4:]
        self.assertEqual(set(seen), prep.SERVICES)
        wrong = copy.deepcopy(obj.old); wrong['worker']['State']['ExitCode'] = 137
        with self.assertRaises(RuntimeError): cut.require_stopped(wrong)
        wrong['worker']['State'] = {'Running':True}
        with self.assertRaises(RuntimeError): cut.require_stopped(wrong)

    def test_nas_start_failure_commits_write_boundary_before_first_start(self):
        obj = self.bare(); actions = []
        def checkpoint(phase, **kw): obj.state.update(kw); actions.append(phase)
        with patch.object(obj, 'checkpoint', side_effect=checkpoint), \
             patch.object(obj, 'seal', side_effect=lambda p: actions.append(p)), \
             patch.object(obj, 'command', side_effect=RuntimeError('start failed')), \
             contextlib.redirect_stdout(io.StringIO()):
            with self.assertRaisesRegex(RuntimeError, 'start failed'): obj.start(consumers(True), True)
        self.assertTrue(obj.state['nas_may_have_writes'])
        self.assertEqual(actions, ['nas_starting','cutover_nas_writes_possible'])

    def test_ssd_recovery_refuses_possible_nas_writes_without_commands(self):
        obj = self.bare()
        state = dict(obj.state, report_directory=obj.path, volume=prep.VOLUME, nas_may_have_writes=True)
        with patch.object(cut, 'read_json', return_value=state), patch.object(obj, 'config_guard'), \
             patch.object(obj, 'open_media'), patch.object(obj, 'command') as command:
            with self.assertRaisesRegex(RuntimeError, 'NAS may contain'): obj.recover('--restore-ssd')
        command.assert_not_called()

    def test_resume_never_syncs_or_recreates(self):
        obj = self.bare(); created = consumers(True)
        state = dict(obj.state, report_directory=obj.path, volume=prep.VOLUME, nas_may_have_writes=True,
                     final_sync_passed=True, new_ids={n:c['Id'] for n,c in created.items()})
        with contextlib.ExitStack() as stack:
            for name in ('config_guard','open_media','identity_probe','http_probe','seal','checkpoint'):
                stack.enter_context(patch.object(obj, name))
            stack.enter_context(patch.object(cut, 'read_json', return_value=state))
            stack.enter_context(patch.object(obj, 'mounted_services', return_value=created))
            stack.enter_context(patch.object(obj, 'start', return_value=created))
            sync = stack.enter_context(patch.object(obj, 'sync'))
            command = stack.enter_context(patch.object(obj, 'command'))
            stack.enter_context(contextlib.redirect_stdout(io.StringIO()))
            obj.recover('--resume-nas')
            sync.assert_not_called(); command.assert_not_called()

    def test_actual_mount_environment_and_id_checks(self):
        obj = self.bare(); actual = consumers(True)
        actual['web']['Config']['Cmd'] = obj.overlay['services']['web']['command']
        def inspect(): return list(actual.values())
        with patch.object(cut.precopy, 'inspect_containers', side_effect=inspect), patch.object(obj, 'databases'):
            self.assertEqual(obj.mounted_services(True), actual)
            for key,value in [('RW',True),('Name','wrong'),('Source','/wrong')]:
                original = actual['gateway']['Mounts'][-1][key]
                actual['gateway']['Mounts'][-1][key] = value
                with self.assertRaises(RuntimeError): obj.mounted_services(True)
                actual['gateway']['Mounts'][-1][key] = original
            actual['worker']['Config']['Env'][0] = 'KEEP_SECRET=changed'
            with self.assertRaisesRegex(RuntimeError, 'environment'): obj.mounted_services(True)
            actual['worker']['Config']['Env'][0] = 'KEEP_SECRET=private'
            with self.assertRaisesRegex(RuntimeError, 'replaced'):
                obj.mounted_services(True, expected_ids={n:'foreign' for n in prep.SERVICES})

    @unittest.skipUnless(shutil.which('rsync'), 'rsync unavailable')
    def test_real_incremental_quarantine_and_quick_check_preserve_source(self):
        with tempfile.TemporaryDirectory() as tmp:
            root = Path(tmp); source = root/'source'; target = root/'job/raw'; output = root/'report'
            source.mkdir(); target.mkdir(parents=True); output.mkdir()
            (source/'video').mkdir(); (target/'video').mkdir()
            (source/'video/kept.bin').write_bytes(b'new-file-content')
            (source/'video/raw-media-live.tmp').write_bytes(b'keep this temp too')
            (target/'video/kept.bin').write_bytes(b'old')
            (target/'video/old\nname.bin').write_bytes(b'NAS-only retained')
            (target/'unused-dir').mkdir(); (target/'unused-dir/data').write_bytes(b'subtree retained')
            paths = [source,target,target.parent,output]
            fds = [os.open(str(p),cut.DIR_FLAGS) for p in paths]
            try:
                before_files = {str(p.relative_to(source)):p.read_bytes() for p in source.rglob('*') if p.is_file()}
                def command():
                    with patch.object(cut.precopy,'descriptor_path',side_effect=lambda fd: str(paths[fds.index(fd)])):
                        cmd = cut.precopy.copy_command(fds[0],fds[1],{'job_id':'f'*32},unlimited=True)
                    return [arg for arg in cmd if arg not in ('--info=progress2','--outbuf=N')]
                self.assertEqual(subprocess.run(command(),stdout=subprocess.PIPE).returncode,0)
                report = Report(io.BytesIO())
                a=inventory(fds[0],'source',report); b=inventory(fds[1],'target',report)
                with contextlib.redirect_stdout(io.StringIO()):
                    self.assertEqual(cut.quarantine_extras(*fds[:2],a,b,*fds[2:]),2)
                self.assertFalse((target/'unused-dir').exists())
                records = [json.loads(line) for line in (output/'quarantine.jsonl').read_text().splitlines()]
                for row in records[::2]: self.assertEqual(row['phase'],'rename_intent')
                saved = {row['source_relative']:target.parent/row['saved_relative'] for row in records[1::2]}
                self.assertEqual(saved['video/old\nname.bin'].read_bytes(),b'NAS-only retained')
                self.assertEqual((saved['unused-dir']/'data').read_bytes(),b'subtree retained')
                self.assertEqual(subprocess.run(command(),stdout=subprocess.PIPE).returncode,0)
                with patch.object(cut,'descriptor_path',side_effect=lambda fd: str(paths[fds.index(fd)])):
                    quick = subprocess.run(cut.quick_command(*fds[:2]),stdout=subprocess.PIPE,stderr=subprocess.PIPE)
                self.assertEqual(quick.returncode,0,quick.stderr); self.assertEqual(quick.stdout,b'')
                self.assertEqual(before_files,{str(p.relative_to(source)):p.read_bytes() for p in source.rglob('*') if p.is_file()})
            finally:
                for fd in reversed(fds): os.close(fd)

    def test_full_workflow_orders_drain_sync_create_start_and_seals_on_failure(self):
        for fail_at in (None, 'final_sync', 'create'):
            obj=self.bare(); obj.original={}; obj.saved['consumer_fingerprint_normalized']='fixture'
            obj.state=None; actions=[]; created=consumers(True)
            def checkpoint(phase, **kw): obj.state.update(kw,phase=phase); actions.append(phase)
            def final_sync():
                actions.append('final_sync')
                if fail_at == 'final_sync': raise RuntimeError('sync failed')
                obj.state['final_sync_passed']=True
            def command(args, **kw):
                if args[:2] == ['docker','diff']: return ''
                actions.append('create')
                if fail_at == 'create': raise RuntimeError('creation failed')
                return ''
            def start(*args):
                actions.append('start'); obj.state['nas_may_have_writes']=True; return created
            with contextlib.ExitStack() as stack:
                patches=[(cut,'read_json',{'side_effect':FileNotFoundError}),
                    (cut.precopy,'inspect_containers',{'return_value':list(obj.old.values())}),
                    (cut.precopy,'check_consumers',{'return_value':'fixture'}),
                    (prep,'validate_config',{'return_value':[]}),
                    (obj,'config_guard',{}),(obj,'open_media',{}),(obj,'originals',{}),
                    (obj,'databases',{'return_value':{'postgres':'db','redis':'queue'}}),
                    (obj,'checkpoint',{'side_effect':checkpoint}),
                    (obj,'seal',{'side_effect':lambda p:actions.append(p)}),
                    (obj,'sync',{'side_effect':lambda:actions.append('online_sync')}),
                    (obj,'stop',{'side_effect':lambda c:actions.append('stop')}),
                    (obj,'final_sync',{'side_effect':final_sync}),
                    (obj,'command',{'side_effect':command}),
                    (obj,'mounted_services',{'return_value':created}),
                    (obj,'start',{'side_effect':start}),
                    (obj,'http_probe',{'side_effect':lambda c:actions.append('http_probe')})]
                for target,name,kw in patches: stack.enter_context(patch.object(target,name,**kw))
                stack.enter_context(contextlib.redirect_stdout(io.StringIO()))
                if fail_at:
                    with self.assertRaises(RuntimeError): obj.execute()
                    self.assertNotIn('start',actions)
                    self.assertIn('cutover_in_progress',actions)
                else:
                    obj.execute()
                    self.assertLess(actions.index('online_sync'),actions.index('stop'))
                    self.assertLess(actions.index('stop'),actions.index('final_sync'))
                    self.assertLess(actions.index('final_sync'),actions.index('create'))
                    self.assertLess(actions.index('create'),actions.index('start'))
                    self.assertLess(actions.index('http_probe'),actions.index('running_on_nas'))
                    self.assertFalse(obj.state['reclaim_ready'])
                    self.assertTrue(obj.state['business_acceptance_pending'])

    def test_repeated_cutover_preserves_reported_write_boundary(self):
        obj=self.bare(); previous={'phase':'running_on_nas','nas_may_have_writes':True}
        with patch.object(cut,'read_json',return_value=previous), patch.object(obj,'config_guard') as guard, \
             contextlib.redirect_stdout(io.StringIO()):
            with self.assertRaisesRegex(RuntimeError,'already has an execution'): obj.execute()
        self.assertIs(obj.state,previous)
        guard.assert_not_called()

    def test_changed_preparation_stops_before_any_production_action(self):
        obj=self.bare(); obj.original={}; obj.saved['consumer_fingerprint_normalized']='expected'; obj.state=None
        with patch.object(cut,'read_json',side_effect=FileNotFoundError), \
             patch.object(obj,'config_guard'), \
             patch.object(cut.precopy,'inspect_containers',return_value=list(obj.old.values())), \
             patch.object(cut.precopy,'check_consumers',return_value='different'), \
             patch.object(obj,'stop') as stop, patch.object(obj,'sync') as sync, \
             patch.object(obj,'command') as command:
            with self.assertRaisesRegex(RuntimeError,'Deployment changed'): obj.execute()
        stop.assert_not_called(); sync.assert_not_called(); command.assert_not_called()
        self.assertIsNone(obj.state)

    def test_http_probe_requires_206_correct_range_length_and_bytes(self):
        import hashlib
        obj=self.bare(); obj.state['sample']={'relative':'video/a file.mp4','size':2048,
            'prefix_sha256':hashlib.sha256(b'a'*1024).hexdigest()}
        cs=consumers(True); cs['gateway']['NetworkSettings']={'Ports':{'8080/tcp':[{'HostIp':'0.0.0.0','HostPort':'59201'}]}}
        from unittest.mock import MagicMock
        response=MagicMock(); response.__enter__.return_value=response
        response.status=206; response.headers={'Content-Range':'bytes 0-1023/2048'}; response.read.return_value=b'a'*1024
        opener=MagicMock(); opener.open.return_value=response
        with patch.object(cut.urllib.request,'build_opener',return_value=opener), contextlib.redirect_stdout(io.StringIO()):
            obj.http_probe(cs)
            request=opener.open.call_args.args[0]
            self.assertIn('a%20file.mp4',request.full_url)
            response.status=200
            with self.assertRaises(RuntimeError):obj.http_probe(cs)
            response.status=206; response.read.return_value=b'b'*1024
            with self.assertRaises(RuntimeError):obj.http_probe(cs)

    def test_private_state_atomic_update_and_unsafe_reads(self):
        with tempfile.TemporaryDirectory() as tmp:
            fd=os.open(tmp,cut.DIR_FLAGS)
            try:
                cut.atomic_json(fd,'execution.json',{'phase':'before'})
                cut.atomic_json(fd,'execution.json',{'phase':'after','nas_may_have_writes':True})
                p=Path(tmp)/'execution.json'
                self.assertEqual(json.loads(p.read_text())['phase'],'after')
                self.assertEqual(stat.S_IMODE(p.stat().st_mode),0o600)
                p.chmod(0o644)
                with self.assertRaises(RuntimeError): cut.read_json(fd,'execution.json')
            finally: os.close(fd)


if __name__ == '__main__': unittest.main()
