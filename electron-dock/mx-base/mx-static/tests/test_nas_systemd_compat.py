import contextlib
import io
import json
import os
from pathlib import Path
import subprocess
import sys
import tempfile
import unittest
from unittest import mock

ROOT=Path(__file__).resolve().parents[1]
sys.path.insert(0,str(ROOT/'scripts/nas'))
import display
import manage
import recovery


class SystemdCompatibilityTests(unittest.TestCase):
    def test_verify_failure_preserves_installed_units_pointer_and_policy(self):
        with tempfile.TemporaryDirectory() as tmp:
            base=Path(tmp);runtime=base/'runtime';config=base/'etc';units=base/'units'
            for p in (runtime,config,units):p.mkdir()
            (runtime/'old').mkdir();(runtime/'current').symlink_to('old')
            old='# Managed by mx-static scripts/manage.sh nas auto-install\n[Service]\nType=oneshot\n'
            for name in manage.unit_files():(units/name).write_text(old)
            policy={'schema':1,'mode':'migrated','enabled_parts':[],'disabled_parts':['part1'],'suspended':False}
            (config/'auto.json').write_text(json.dumps(policy));before=(config/'auto.json').read_bytes()
            def secure(path):return os.open(str(units if path=='/etc/systemd/system' else Path(path)),manage.DIR_FLAGS)
            def run(args,**kw):
                self.assertEqual(args[:3],['systemd-analyze','--man=no','verify'])
                self.assertEqual(os.readlink(str(runtime/'current')),'old')
                self.assertTrue(all((units/n).read_text()==old for n in manage.unit_files()))
                self.assertIn('\nType=simple\n',Path(args[3]).read_text())
                raise RuntimeError('server rejected candidate')
            with mock.patch.object(manage,'RUNTIME',str(runtime)),mock.patch.object(manage,'AUTO_DIR',str(config)),mock.patch.object(manage,'secure_directory',side_effect=secure),mock.patch.object(manage,'run',side_effect=run) as invoked,self.assertRaises(RuntimeError):
                manage.install_auto()
            self.assertEqual(invoked.call_count,1)
            self.assertEqual(os.readlink(str(runtime/'current')),'old')
            self.assertEqual((config/'auto.json').read_bytes(),before)
            self.assertTrue(all((units/n).read_text()==old for n in manage.unit_files()))

    def test_systemd_failure_retains_private_diagnostic_without_printing_output(self):
        with tempfile.TemporaryDirectory() as tmp:
            result=subprocess.CompletedProcess([],1,stdout='private-out',stderr='bad-setting; private-value')
            with mock.patch.object(manage.subprocess,'run',return_value=result),mock.patch.object(manage,'secure_directory',side_effect=lambda p:os.open(tmp,manage.DIR_FLAGS)),self.assertRaises(RuntimeError) as raised:
                manage.run(['systemctl','enable','--now',manage.UNIT+'.timer'])
            self.assertIn('/var/log/mx-static-nas/systemd-error-',str(raised.exception))
            self.assertNotIn('private-value',str(raised.exception))
            files=list(Path(tmp).glob('*.json'));self.assertEqual(len(files),1)
            self.assertEqual(files[0].stat().st_mode & 0o777,0o600)
            saved=json.loads(files[0].read_text());self.assertIn('bad-setting',saved['stderr']);self.assertEqual(saved['exit'],1)

    def test_docker_errors_remain_private(self):
        result=subprocess.CompletedProcess([],1,stdout='',stderr='PASSWORD=private-value')
        with mock.patch.object(manage.subprocess,'run',return_value=result),mock.patch.object(manage,'secure_directory') as opened,self.assertRaises(RuntimeError) as raised:
            manage.run(['docker','compose','ps'])
        self.assertNotIn('private-value',str(raised.exception));opened.assert_not_called()

    def test_bad_setting_is_not_displayed_as_an_ordinary_stopped_service(self):
        output=display.units('Id=mx-static-nas-boot.service\nLoadState=bad-setting\nActiveState=inactive\nSubState=dead\nUnitFileState=static\n')
        self.assertIn('配置错误 (bad-setting)',output);self.assertNotIn('inactive/dead',output)

    def test_failed_timer_enable_explains_saved_policy_and_never_rolls_back(self):
        with mock.patch.object(manage,'run',side_effect=RuntimeError('systemctl failed')) as run,self.assertRaises(RuntimeError) as raised:
            manage.enable_timer()
        self.assertIn('恢复策略已保存',str(raised.exception));self.assertIn('尚不能确认恢复生效',str(raised.exception))
        run.assert_called_once_with(['systemctl','enable','--now',manage.UNIT+'.timer'])

    def test_policy_is_saved_before_timer_attempt_but_no_success_event_on_failure(self):
        policy={'schema':1,'enabled_parts':[],'mode':'explicit','disabled_parts':[],'suspended':False}
        order=[]
        def enable_failure():
            order.append('enable')
            raise RuntimeError('failed')
        with mock.patch.object(recovery,'installed_current',return_value=True),mock.patch.object(recovery,'show',return_value=(policy,[{'task':'part1','state':'eligible'}])),mock.patch.object(recovery,'save',side_effect=lambda *a:order.append('save')),mock.patch.object(manage,'enable_timer',side_effect=enable_failure),mock.patch.object(recovery,'emit') as emit,self.assertRaises(RuntimeError):
            recovery.enable_migrated(manage)
        self.assertEqual(order,['save','enable']);emit.assert_not_called()


if __name__=='__main__':unittest.main()
