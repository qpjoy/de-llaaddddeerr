"""Pure, strict comparison of complete local Docker migration checkpoints.

Only probe diagnostics and enumeration order are non-semantic.  Mount sources
are opaque strings: no filesystem access, path resolution or mount inspection
takes place here.  Unknown fields remain part of the comparison, but their
names and values never appear in the public difference summary.
"""
import json

import runtime_check


class Error(RuntimeError):
    """An invalid checkpoint; never includes any checkpoint content."""

    def __init__(self):
        super().__init__('Docker comparison requires complete valid checkpoints; raw values hidden')


INFO_FIELDS = ('root', 'live_restore', 'name', 'swarm_state')
CONTAINER_FIELDS = ('name', 'running', 'paused', 'restart_policy', 'stop_signal')
MOUNT_FIELDS = ('Type', 'Name', 'Source', 'Destination', 'Driver', 'Mode', 'RW', 'Propagation')
COUNT_FIELDS = ('total', 'inspected_total', 'running', 'paused')
TOP_FIELDS = COUNT_FIELDS + ('complete', 'containers_complete')
TOP_PAYLOADS = ('info', 'containers', 'mounts', 'diagnostics')


def _require(condition):
    if not condition:
        raise Error()


def _encode(value):
    # Canonical JSON retains distinctions that Python equality loses, such as
    # an unknown field changing from true to 1 or from 1 to 1.0.
    return json.dumps(value, ensure_ascii=True, sort_keys=True,
                      separators=(',', ':'), allow_nan=False)


def _json_types(value):
    kind = type(value)
    if kind is dict:
        _require(all(type(key) is str for key in value))
        for item in value.values():
            _json_types(item)
    elif kind is list:
        for item in value:
            _json_types(item)
    else:
        _require(value is None or kind in (str, bool, int, float))


def _validated(snapshot):
    """Return an independent JSON copy, retaining every observed field."""
    try:
        _json_types(snapshot)
        value = json.loads(_encode(snapshot))
        _require(type(value) is dict)
        _require(value.get('complete') is True and value.get('containers_complete') is True)
        _require(type(value.get('diagnostics')) is list)
        _require(type(value.get('info')) is dict)
        runtime_check.docker_info(_encode(value['info']))
        _require(type(value.get('containers')) is list and type(value.get('mounts')) is dict)
        containers = value['containers']
        for container in containers:
            runtime_check.docker_container(container)
        ids = [container['id'] for container in containers]
        _require(len(ids) == len(set(ids)) and set(value['mounts']) == set(ids))
        _require(all(type(value.get(field)) is int and value[field] >= 0 for field in COUNT_FIELDS))
        _require(value['total'] == value['inspected_total'] == len(containers))
        _require(value['running'] == sum(container['running'] for container in containers))
        _require(value['paused'] == sum(container['paused'] for container in containers))
        for mounts in value['mounts'].values():
            _require(type(mounts) is list)
            destinations = set()
            for mount in mounts:
                _require(type(mount) is dict and type(mount.get('Source')) is str)
                destination = mount.get('Destination')
                _require(type(destination) is str and bool(destination) and destination not in destinations)
                destinations.add(destination)
        return value
    except (ValueError, TypeError, KeyError, AttributeError, OverflowError, RecursionError):
        raise Error() from None


def _normalized(value):
    # The caller supplies an independent, validated copy.
    value.pop('diagnostics')
    value['containers'].sort(key=lambda container: container['id'])
    for mounts in value['mounts'].values():
        mounts.sort(key=_encode)
    return _encode(value)


def normalize(snapshot):
    """Validate and return canonical JSON; never mutate the input checkpoint."""
    return _normalized(_validated(snapshot))


def _different(left, right, key):
    if (key in left) != (key in right):
        return True
    return key in left and _encode(left[key]) != _encode(right[key])


def _fields(left, right, allowed, excluded=()):
    changed = [field for field in allowed if _different(left, right, field)]
    known = set(allowed) | set(excluded)
    unknown_left = {key: value for key, value in left.items() if key not in known}
    unknown_right = {key: value for key, value in right.items() if key not in known}
    if _encode(unknown_left) != _encode(unknown_right):
        changed.append('other')
    return changed


def _mount_fields(left, right):
    before = {mount['Destination']: mount for mount in left}
    after = {mount['Destination']: mount for mount in right}
    changed = set()
    if set(before) != set(after):
        changed.update(('Destination', 'membership'))
    for destination in set(before) & set(after):
        changed.update(_fields(before[destination], after[destination], MOUNT_FIELDS))
    return [field for field in MOUNT_FIELDS + ('other', 'membership') if field in changed]


def compare(before, after):
    """Compare complete checkpoints and return only IDs and fixed field names.

    ``equivalent`` is exactly ``normalize(before) == normalize(after)``.
    ``raw_equal`` compares the complete JSON data, including diagnostics and
    list order.  Neither result alone is available for invalid checkpoints.
    """
    left, right = _validated(before), _validated(after)
    raw_equal = _encode(left) == _encode(right)
    left_ids = [container['id'] for container in left['containers']]
    right_ids = [container['id'] for container in right['containers']]
    left_containers = {container['id']: container for container in left['containers']}
    right_containers = {container['id']: container for container in right['containers']}
    common = sorted(set(left_ids) & set(right_ids))
    ignored = []
    if left_ids != right_ids and sorted(left_ids) == sorted(right_ids):
        ignored.append('container_order')
    if any(_encode(left['mounts'][identifier]) != _encode(right['mounts'][identifier]) and
           sorted(_encode(mount) for mount in left['mounts'][identifier]) ==
           sorted(_encode(mount) for mount in right['mounts'][identifier])
           for identifier in common):
        ignored.append('mount_order')
    if _different(left, right, 'diagnostics'):
        ignored.append('probe_diagnostics')
    container_changes, mount_changes = [], []
    for identifier in common:
        fields = _fields(left_containers[identifier], right_containers[identifier],
                         CONTAINER_FIELDS, ('id',))
        if fields:
            container_changes.append({'id': identifier, 'fields': fields})
        fields = _mount_fields(left['mounts'][identifier], right['mounts'][identifier])
        if fields:
            mount_changes.append({'id': identifier, 'fields': fields})
    changes = {
        'info_fields': _fields(left['info'], right['info'], INFO_FIELDS),
        'containers_added': sorted(set(right_ids) - set(left_ids)),
        'containers_removed': sorted(set(left_ids) - set(right_ids)),
        'container_changes': container_changes,
        'mount_changes': mount_changes,
        'other_fields': _fields(left, right, TOP_FIELDS, TOP_PAYLOADS),
    }
    return {'schema_version': 1, 'raw_equal': raw_equal,
            'equivalent': _normalized(left) == _normalized(right),
            'ignored_differences': ignored, 'changes': changes}
