"""Offline adapter contract checks; no live requests and no real credentials."""
from copy import deepcopy
import importlib.util
import io
import json
import os
from pathlib import Path
import subprocess
import sys
import types
import unittest
from unittest.mock import Mock, patch

ROOT = Path(__file__).resolve().parents[1]
spec = importlib.util.spec_from_file_location('local_adapter', ROOT / 'adapter.py')
adapter = importlib.util.module_from_spec(spec)
spec.loader.exec_module(adapter)
EXAMPLE = json.loads((ROOT/'examples/adapter-request.json').read_text(encoding='utf-8'))


def request_for(operation):
    """Create synthetic parameters at the adapter boundary (not live inputs)."""
    definition = adapter.SPEC['operations'][operation]['input_schema']
    values = {}
    for name in definition['required']:
        prop = definition['properties'][name]
        kind = prop.get('type')
        kind = kind[0] if isinstance(kind, list) else kind
        values[name] = {'string':'example.com', 'array':['example.com'], 'integer':1,
                        'number':1.0, 'boolean':False, 'object':{}}.get(kind, 'example.com')
    return {'operation':operation, 'params':values}


class AdapterTests(unittest.TestCase):
    def test_preserves_nested_result_and_request(self):
        native = {'status':'success','data':{'items':[{'score':0,'active':False}], 'next_cursor':'page-2'},
                  'warnings':['sample'], 'observed_at':'original', 'error':None}
        request = deepcopy(EXAMPLE)
        def fake(operation, params):
            params.clear()
            return native
        with patch.object(adapter, '_call', side_effect=fake):
            result = adapter.invoke(request)
        self.assertEqual(request, EXAMPLE)
        self.assertEqual(result['result'], native)
        self.assertEqual(result['status'], 'success')
        self.assertEqual(result['project_id'], adapter.SPEC['project_id'])

    def test_statuses_and_batch(self):
        samples = [('success','success'),('failed','error'),('partial','partial'),('no_data','no_data'),
                   ('unknown','unknown'),('stopped','stopped'),('not_verified','unknown')]
        for old, new in samples:
            with self.subTest(old=old), patch.object(adapter,'_call',return_value={'status':old}):
                result = adapter.invoke(EXAMPLE)
                self.assertEqual(result['status'],new)
                self.assertEqual(result['result']['status'],old)
        for native, expected in [([], 'no_data'),([{'status':'success'}]*2,'success'),
                                 ([{'status':'success'},{'status':'error'}],'partial'),
                                 ([{'status':'error'}]*2,'error')]:
            with patch.object(adapter,'_call',return_value=native):
                self.assertEqual(adapter.invoke(EXAMPLE)['status'],expected)

    def test_invalid_requests_do_not_call_sdk(self):
        cases = [None, [], {}, {'operation':[]}, {'operation':'__import__'},
                 {**EXAMPLE,'extra':'unsupported'}, {**EXAMPLE,'params':None},
                 {**EXAMPLE,'params':{**EXAMPLE['params'],'unexpected':1}}]
        with patch.object(adapter,'_call') as call:
            for request in cases:
                self.assertEqual(adapter.invoke(request)['status'],'error')
            call.assert_not_called()

    def test_every_operation_binding(self):
        for operation, declaration in adapter.SPEC['operations'].items():
            request = request_for(operation)
            native = {'status':'success','data':{'next_page_token':'kept'}}
            function = Mock(return_value=native)
            module = types.SimpleNamespace()
            if declaration['kind']=='shodan':
                client=Mock()
                client.execute=function
                setattr(client, operation, function)
                manager=Mock()
                manager.__enter__=Mock(return_value=client)
                manager.__exit__=Mock(return_value=False)
                module.ShodanClient=Mock(return_value=manager)
            else:
                setattr(module,declaration['function'],function)
            with self.subTest(operation=operation), patch.object(adapter.importlib,'import_module',return_value=module) as imported:
                result=adapter.invoke(request)
                self.assertEqual(result['status'],'success')
                imported.assert_called_once_with(declaration['module'])
                params=dict(request['params'])
                if declaration['kind']=='shodan' and operation not in ('hosts','search_pages'):
                    function.assert_called_once_with(operation,**params)
                elif declaration.get('preset_operation'):
                    function.assert_called_once_with(operation=operation,**params)
                else:
                    function.assert_called_once_with(**params)

    def test_required_and_types(self):
        for operation, definition in adapter.SPEC['operations'].items():
            request=request_for(operation)
            with patch.object(adapter,'_call') as call:
                for name in definition['input_schema']['required']:
                    invalid=deepcopy(request)
                    del invalid['params'][name]
                    self.assertEqual(adapter.invoke(invalid)['status'],'error')
                call.assert_not_called()
        request=deepcopy(EXAMPLE)
        for value in (float('nan'),float('inf')):
            with self.assertRaises(adapter.AdapterError):
                adapter._validate(value,{'type':'number'})
        with self.assertRaises(adapter.AdapterError):
            adapter._validate(True,{'type':'integer'})

    def test_exceptions_never_echo_secret(self):
        for exception, code in [(ValueError('synthetic-key'),'INVALID_PARAMS'),
                                 (ModuleNotFoundError('synthetic-key'),'DEPENDENCY_MISSING'),
                                 (FileNotFoundError('synthetic-key'),'REQUIRED_FILE_MISSING'),
                                 (RuntimeError('synthetic-key'),'EXECUTION_ERROR'),
                                 (SystemExit('synthetic-key'),'EXECUTION_ERROR')]:
            with patch.object(adapter,'_call',side_effect=exception):
                result=adapter.invoke(EXAMPLE)
                self.assertEqual(result['error']['code'],code)
                self.assertNotIn('synthetic-key',json.dumps(result))

    def test_non_json_result_fails_explicitly(self):
        for native in [42, 'unexpected scalar', None, {'status':'success','data':object()}, {'status':'success','score':float('nan')}]:
            with patch.object(adapter,'_call',return_value=native):
                result=adapter.invoke(EXAMPLE)
                self.assertEqual(result['error']['code'],'INVALID_RESULT')
                self.assertIsNone(result['result'])

    def test_cli_invalid_json_and_unknown_operation(self):
        for content, code in [(b'{','INVALID_JSON'),(b'\xff','INVALID_JSON'),
                              (b'{"operation":"__unknown__"}','UNKNOWN_OPERATION'),
                              (b'{"operation":NaN}','INVALID_JSON')]:
            run=subprocess.run([sys.executable,str(ROOT/'adapter.py')],input=content,
                               capture_output=True,timeout=10)
            self.assertEqual(run.returncode,1)
            self.assertEqual(json.loads(run.stdout)['error']['code'],code)
            self.assertNotIn(b'Traceback',run.stderr)

    def test_native_and_python_logs_go_to_stderr(self):
        script = '''import adapter, json, os
def fake(operation, params):
 print("python diagnostic")
 os.write(1, b"native diagnostic\\n")
 return {"status":"success","data":{"items":[1]}}
adapter._call=fake
raise SystemExit(adapter.main())
'''
        run=subprocess.run([sys.executable,'-c',script],cwd=ROOT,
                           input=json.dumps(EXAMPLE).encode(),capture_output=True,timeout=10)
        self.assertEqual(run.returncode,0)
        self.assertEqual(json.loads(run.stdout)['status'],'success')
        self.assertIn(b'python diagnostic',run.stderr)
        self.assertIn(b'native diagnostic',run.stderr)

    def test_monitor_and_event_page_contract(self):
        if 'monitor_certificates' not in adapter.SPEC['operations']:
            return
        request=deepcopy(EXAMPLE)
        for value in (None,0,-1,True,float('inf')):
            request['params']['duration_seconds']=value
            with patch.object(adapter,'_call') as call:
                self.assertEqual(adapter.invoke(request)['status'],'error')
                call.assert_not_called()
        request={'operation':'read_certificate_events','params':{'state_dir':'data/example'}}
        for items, status in [([],'no_data'),([{'event_id':1}],'success')]:
            native={'items':items,'next_cursor':1}
            with patch.object(adapter,'_call',return_value=native):
                result=adapter.invoke(request)
                self.assertEqual(result['status'],status)
                self.assertEqual(result['result'],native)


if __name__=='__main__':
    unittest.main()
