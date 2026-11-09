"""Explicit per-market mappings, without treating echoed inputs as app records."""
from .config import MARKET

MAPPINGS = {'wandoujia': dict(package='data_pn',app_id='app_id',name='name',version='version',version_code='versionCode',developer='developer',privacy_policy_url='privacyPolicyUrl',download_url='downloads',updated_at='updateTime',icon_url='iconUrl')}


def normalize(payload: dict, source_url: str) -> dict | None:
    data=payload.get('appMap') if MARKET=='xiaomi' else payload
    if not isinstance(data,dict):return None
    mapped={key:data.get(field) for key,field in MAPPINGS[MARKET].items()}
    if not mapped.get('name') or not (mapped.get('package') or mapped.get('app_id')):return None
    if not (mapped.get('version') or mapped.get('version_code')):return None
    if MARKET=='xiaomi':mapped['download_url']=payload.get('download')
    # Vivo only exposes a relative APK path here; do not invent an absolute URL.
    if MARKET=='vivo':mapped['download_path']=data.get('apk')
    meta=payload.get('_meta',{})
    return {'input_value':meta.get('input_value'),'record_type':meta.get('record_type'),
            'source_url':source_url,'app':mapped,'raw':payload}
