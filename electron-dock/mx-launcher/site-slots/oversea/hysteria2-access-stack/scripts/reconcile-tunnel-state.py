#!/usr/bin/env python3
import argparse
import json
import sys
from pathlib import Path


def die(message):
    print(f"tunnel-state: {message}", file=sys.stderr)
    raise SystemExit(1)


def safe_name(value):
    out = "".join(ch if ch.isalnum() or ch in "_.-" else "_" for ch in str(value or "").strip())
    return out[:64]


def clean_cell(value, field, optional=False):
    out = str(value or "").strip()
    if not out and optional:
        return ""
    if not out:
        die(f"missing {field}")
    if "," in out or "\n" in out or "\r" in out:
        die(f"{field} cannot contain comma or newline")
    return out


def shell_quote(value):
    return "'" + str(value).replace("'", "'\\''") + "'"


def main():
    parser = argparse.ArgumentParser()
    parser.add_argument("--state-file", required=True)
    parser.add_argument("--users-file", required=True)
    parser.add_argument("--output-env-file", required=True)
    args = parser.parse_args()

    state = json.loads(Path(args.state_file).read_text(encoding="utf-8"))
    accounts = state.get("accounts") if isinstance(state.get("accounts"), list) else []
    policies = state.get("policies") if isinstance(state.get("policies"), list) else []
    default_policy = next((row for row in policies if isinstance(row, dict) and row.get("isDefault")), None)
    if default_policy is None and policies:
        default_policy = policies[0]
    policy_by_id = {str(row.get("id", "")): row for row in policies if isinstance(row, dict)}

    rows = ["name,auth,up,down"]
    for account in accounts:
        if not isinstance(account, dict):
            continue
        if account.get("status") and account.get("status") != "active":
            continue
        username = safe_name(account.get("username") or account.get("id"))
        auth_token = clean_cell(account.get("authToken"), "authToken")
        up_rate = clean_cell(account.get("upRate", ""), "upRate", True)
        down_rate = clean_cell(account.get("downRate", ""), "downRate", True)
        if username and auth_token:
            rows.append(",".join([username, auth_token, up_rate, down_rate]))

    Path(args.users_file).write_text("\n".join(rows) + "\n", encoding="utf-8")
    Path(args.users_file).chmod(0o600)

    selected_policy = default_policy
    if selected_policy is None and accounts and isinstance(accounts[0], dict):
        selected_policy = policy_by_id.get(str(accounts[0].get("policyId", "")))
    if not isinstance(selected_policy, dict):
        selected_policy = {}

    routing_mode = selected_policy.get("routingMode")
    if routing_mode not in ("internal-mihomo", "cn-direct", "global"):
        routing_mode = "cn-direct"
    cidrs = selected_policy.get("reservedInternalCidrs")
    if isinstance(cidrs, list):
        reserved_internal_cidrs = ",".join(
            cell for cell in (clean_cell(cidr, "reservedInternalCidrs", True) for cidr in cidrs) if cell
        )
    else:
        reserved_internal_cidrs = "10.88.0.0/16,10.89.0.0/16,10.90.0.0/16,10.91.0.0/16"

    node = state.get("node") if isinstance(state.get("node"), dict) else {}
    env = {
        "TUNNEL_REVISION": clean_cell(state.get("revision", ""), "revision", True),
        "TUNNEL_NODE_PUBLIC_HOST": clean_cell(node.get("publicHost", ""), "publicHost", True),
        "TUNNEL_NODE_SERVER_PORTS": clean_cell(node.get("serverPorts", ""), "serverPorts", True),
        "TUNNEL_ROUTING_MODE": routing_mode,
        "TUNNEL_SUBSCRIPTION_SOURCE": "internal",
        "TUNNEL_RESERVED_INTERNAL_CIDRS": reserved_internal_cidrs,
        "TUNNEL_DOMESTIC_GATEWAY_IP": clean_cell(
            selected_policy.get("domesticGatewayIp", "10.88.0.1"),
            "domesticGatewayIp",
            True,
        ),
        "TUNNEL_DNS_PATH": clean_cell(
            selected_policy.get("dnsPath", "wg-relay-internal-dns"),
            "dnsPath",
            True,
        ),
        "TUNNEL_ACCOUNT_COUNT": str(len(rows) - 1),
    }
    Path(args.output_env_file).write_text(
        "\n".join(f"{key}={shell_quote(value)}" for key, value in env.items()) + "\n",
        encoding="utf-8",
    )
    Path(args.output_env_file).chmod(0o600)


if __name__ == "__main__":
    main()
