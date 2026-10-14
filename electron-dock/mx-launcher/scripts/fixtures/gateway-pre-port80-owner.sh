source_config=/etc/caddy-source/Caddyfile
runtime_config=/tmp/mx-internal-gateway.Caddyfile
if awk 'NR > 1 { split($2, address, ":"); if (toupper(address[2]) == "0050" && $4 == "0A") found=1 } END { exit found ? 0 : 1 }' /proc/net/tcp /proc/net/tcp6 2>/dev/null; then
  echo "host port 80 is already in use; starting Internal gateway on fallback port 8008"
  awk '
    function brace_delta(line, copy, count) {
      copy = line
      count = gsub(/\{/, "{", copy)
      copy = line
      count -= gsub(/\}/, "}", copy)
      return count
    }
    /mx-gateway-optional-port-80:start/ { skip=1; next }
    /mx-gateway-optional-port-80:end/ { skip=0; next }
    skip_unmarked {
      depth += brace_delta($0)
      if (depth <= 0) skip_unmarked=0
      next
    }
    /^[[:space:]]*:80[[:space:]]*\{/ {
      skip_unmarked=1
      depth = brace_delta($0)
      if (depth <= 0) skip_unmarked=0
      next
    }
    !skip { print }
  ' "$source_config" >"$runtime_config"
else
  cp "$source_config" "$runtime_config"
fi
exec caddy run --config "$runtime_config" --adapter caddyfile
