# Derived from halifox/app_market_crawler; local import paths adjusted 2026-09-12.
import json


def find_object_with_keys(obj, keys):
    if isinstance(obj, dict):
        if keys.issubset(obj.keys()):
            return obj
        for value in obj.values():
            result = find_object_with_keys(value, keys)
            if result:
                return result
    elif isinstance(obj, list):
        for item in obj:
            result = find_object_with_keys(item, keys)
            if result:
                return result
    return None


def find_nested_key(obj, target_key):
    if isinstance(obj, dict):
        if target_key in obj:
            return obj[target_key]
        for value in obj.values():
            result = find_nested_key(value, target_key)
            if result is not None:
                return result
    elif isinstance(obj, list):
        for item in obj:
            result = find_nested_key(item, target_key)
            if result is not None:
                return result
    return None


def find_by_condition(obj, condition: dict):
    results = []
    if isinstance(obj, dict):
        if all(obj.get(k) == v for k, v in condition.items()):
            results.append(obj)
        for value in obj.values():
            results.extend(find_by_condition(value, condition))
    elif isinstance(obj, list):
        for item in obj:
            results.extend(find_by_condition(item, condition))
    return results


def find_first_by_condition(obj, condition: dict):
    if isinstance(obj, dict):
        if all(obj.get(k) == v for k, v in condition.items()):
            return obj
        for value in obj.values():
            found = find_first_by_condition(value, condition)
            if found:
                return found
    elif isinstance(obj, list):
        for item in obj:
            found = find_first_by_condition(item, condition)
            if found:
                return found
    return None


def merge_dicts_ignore_none(*dicts):
    result = {}
    for data in dicts:
        for key, value in data.items():
            if value is None:
                if key not in result:
                    result[key] = None
            else:
                result[key] = value
    return result


def json2file(data, filename="data.json"):
    with open(filename, "w", encoding="utf-8") as file_obj:
        json.dump(data, file_obj, ensure_ascii=False, indent=2)

