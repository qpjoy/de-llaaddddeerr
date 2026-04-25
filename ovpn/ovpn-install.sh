#!/bin/bash
#
# https://github.com/Nyr/openvpn-install
#
# Copyright (c) 2013 Nyr. Released under the MIT License.


# Detect Debian users running the script with "sh" instead of bash
if readlink /proc/$$/exe | grep -q "dash"; then
	echo 'This installer needs to be run with "bash", not "sh".'
	exit
fi

# Discard stdin. Needed when running from an one-liner which includes a newline
read -N 999999 -t 0.001

# Detect OpenVZ 6
if [[ $(uname -r | cut -d "." -f 1) -eq 2 ]]; then
	echo "The system is running an old kernel, which is incompatible with this installer."
	exit
fi

# Detect OS
# $os_version variables aren't always in use, but are kept here for convenience
if grep -qs "ubuntu" /etc/os-release; then
	os="ubuntu"
	os_version=$(grep 'VERSION_ID' /etc/os-release | cut -d '"' -f 2 | tr -d '.')
	group_name="nogroup"
elif [[ -e /etc/debian_version ]]; then
	os="debian"
	os_version=$(grep -oE '[0-9]+' /etc/debian_version | head -1)
	group_name="nogroup"
elif [[ -e /etc/almalinux-release || -e /etc/rocky-release || -e /etc/centos-release ]]; then
	os="centos"
	os_version=$(grep -shoE '[0-9]+' /etc/almalinux-release /etc/rocky-release /etc/centos-release | head -1)
	group_name="nobody"
elif [[ -e /etc/fedora-release ]]; then
	os="fedora"
	os_version=$(grep -oE '[0-9]+' /etc/fedora-release | head -1)
	group_name="nobody"
else
	echo "This installer seems to be running on an unsupported distribution.
Supported distros are Ubuntu, Debian, AlmaLinux, Rocky Linux, CentOS and Fedora."
	exit
fi

if [[ "$os" == "ubuntu" && "$os_version" -lt 1804 ]]; then
	echo "Ubuntu 18.04 or higher is required to use this installer.
This version of Ubuntu is too old and unsupported."
	exit
fi

if [[ "$os" == "debian" ]]; then
	if grep -q '/sid' /etc/debian_version; then
		echo "Debian Testing and Debian Unstable are unsupported by this installer."
		exit
	fi
	if [[ "$os_version" -lt 9 ]]; then
		echo "Debian 9 or higher is required to use this installer.
This version of Debian is too old and unsupported."
		exit
	fi
fi

if [[ "$os" == "centos" && "$os_version" -lt 7 ]]; then
	echo "CentOS 7 or higher is required to use this installer.
This version of CentOS is too old and unsupported."
	exit
fi

# Detect environments where $PATH does not include the sbin directories
if ! grep -q sbin <<< "$PATH"; then
	echo '$PATH does not include sbin. Try using "su -" instead of "su".'
	exit
fi

if [[ "$EUID" -ne 0 ]]; then
	echo "This installer needs to be run with superuser privileges."
	exit
fi

if [[ ! -e /dev/net/tun ]] || ! ( exec 7<>/dev/net/tun ) 2>/dev/null; then
	echo "The system does not have the TUN device available.
TUN needs to be enabled before running this installer."
	exit
fi

SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
CHINA_ROUTES_FILE="$SCRIPT_DIR/china-ipv4.txt"
CHINA_COARSE_ROUTES_FILE="$SCRIPT_DIR/china-ipv4-coarse.txt"
LOCAL_DIRECT_DOMAINS_FILE="$SCRIPT_DIR/local-direct-domains.txt"
DEFAULT_CHINA_COARSE_PREFIX="${CHINA_COARSE_PREFIX:-10}"

trim_spaces () {
	sed 's/^[[:space:]]*//;s/[[:space:]]*$//' <<< "$1"
}

validate_cidr () {
	local cidr="$1"
	local ip prefix octet
	local -a octets

	if ! [[ "$cidr" =~ ^([0-9]{1,3}\.){3}[0-9]{1,3}/([0-9]|[12][0-9]|3[0-2])$ ]]; then
		return 1
	fi

	ip="${cidr%/*}"
	prefix="${cidr#*/}"
	IFS='.' read -r -a octets <<< "$ip"

	if [[ "${#octets[@]}" -ne 4 ]]; then
		return 1
	fi

	for octet in "${octets[@]}"; do
		if [[ "$octet" -lt 0 || "$octet" -gt 255 ]]; then
			return 1
		fi
	done

	if [[ "$prefix" -lt 0 || "$prefix" -gt 32 ]]; then
		return 1
	fi

	return 0
}

validate_cidr_list () {
	local cidr_list="$1"
	local allow_empty="${2:-false}"
	local cidr
	local -a cidrs

	if [[ -z "$cidr_list" ]]; then
		[[ "$allow_empty" == "true" ]] && return 0 || return 1
	fi

	local IFS=','
	read -r -a cidrs <<< "$cidr_list"

	for cidr in "${cidrs[@]}"; do
		cidr=$(trim_spaces "$cidr")
		if [[ -z "$cidr" ]] || ! validate_cidr "$cidr"; then
			return 1
		fi
	done

	return 0
}

normalize_cidr_list () {
	local cidr_list="$1"
	local normalized=()
	local cidr
	local -a cidrs

	local IFS=','
	read -r -a cidrs <<< "$cidr_list"

	for cidr in "${cidrs[@]}"; do
		cidr=$(trim_spaces "$cidr")
		[[ -n "$cidr" ]] && normalized+=("$cidr")
	done

	(
		local IFS=','
		echo "${normalized[*]}"
	)
}

validate_domain_name () {
	local domain="$1"

	[[ "$domain" =~ ^([A-Za-z0-9-]+\.)+[A-Za-z]{2,}$ ]]
}

validate_domain_list () {
	local domain_list="$1"
	local allow_empty="${2:-false}"
	local domain
	local -a domains

	if [[ -z "$domain_list" ]]; then
		[[ "$allow_empty" == "true" ]] && return 0 || return 1
	fi

	local IFS=','
	read -r -a domains <<< "$domain_list"

	for domain in "${domains[@]}"; do
		domain=$(trim_spaces "$domain")
		if [[ -z "$domain" ]] || ! validate_domain_name "$domain"; then
			return 1
		fi
	done

	return 0
}

normalize_domain_list () {
	local domain_list="$1"
	local normalized=()
	local domain
	local -a domains

	local IFS=','
	read -r -a domains <<< "$domain_list"

	for domain in "${domains[@]}"; do
		domain=$(trim_spaces "$domain")
		[[ -n "$domain" ]] && normalized+=("$domain")
	done

	(
		local IFS=','
		echo "${normalized[*]}"
	)
}

cidr_to_netmask () {
	local prefix="$1"
	local full_octets=$((prefix / 8))
	local partial_bits=$((prefix % 8))
	local mask=()
	local index value

	for index in 0 1 2 3; do
		if [[ "$index" -lt "$full_octets" ]]; then
			value=255
		elif [[ "$index" -eq "$full_octets" && "$partial_bits" -gt 0 ]]; then
			value=$((256 - 2 ** (8 - partial_bits)))
		else
			value=0
		fi
		mask+=("$value")
	done

	(
		local IFS='.'
		echo "${mask[*]}"
	)
}

emit_cidr_routes () {
	local cidr_list="$1"
	local gateway="$2"
	local cidr network prefix mask
	local -a cidrs

	[[ -z "$cidr_list" ]] && return

	local IFS=','
	read -r -a cidrs <<< "$cidr_list"

	for cidr in "${cidrs[@]}"; do
		cidr=$(trim_spaces "$cidr")
		[[ -z "$cidr" ]] && continue
		network="${cidr%/*}"
		prefix="${cidr#*/}"
		mask=$(cidr_to_netmask "$prefix")
		echo "route $network $mask $gateway"
	done
}

emit_cidr_routes_from_file () {
	local route_file="$1"
	local gateway="$2"
	local cidr

	[[ ! -s "$route_file" ]] && return

	while IFS= read -r cidr; do
		cidr=$(trim_spaces "$cidr")
		[[ -z "$cidr" || "$cidr" == \#* ]] && continue
		emit_cidr_routes "$cidr" "$gateway"
	done < "$route_file"
}

resolve_domain_ipv4s () {
	local domain="$1"

	if hash getent 2>/dev/null; then
		getent ahostsv4 "$domain" 2>/dev/null | awk '{print $1}' | grep -E '^[0-9]+\.[0-9]+\.[0-9]+\.[0-9]+$' | sort -u
	elif hash dig 2>/dev/null; then
		dig +short A "$domain" 2>/dev/null | grep -E '^[0-9]+\.[0-9]+\.[0-9]+\.[0-9]+$' | sort -u
	elif hash host 2>/dev/null; then
		host -t A "$domain" 2>/dev/null | awk '/ has address / {print $4}' | grep -E '^[0-9]+\.[0-9]+\.[0-9]+\.[0-9]+$' | sort -u
	elif hash nslookup 2>/dev/null; then
		nslookup "$domain" 2>/dev/null | awk '/^Address: / {print $2}' | grep -E '^[0-9]+\.[0-9]+\.[0-9]+\.[0-9]+$' | sort -u
	fi
}

emit_host_routes_from_ips () {
	local gateway="$1"
	local ip

	while IFS= read -r ip; do
		[[ -n "$ip" ]] && echo "route $ip 255.255.255.255 $gateway"
	done
}

emit_domain_host_routes_from_list () {
	local domain_list="$1"
	local gateway="$2"
	local domain
	local -a domains

	[[ -z "$domain_list" ]] && return

	local IFS=','
	read -r -a domains <<< "$domain_list"

	for domain in "${domains[@]}"; do
		domain=$(trim_spaces "$domain")
		[[ -z "$domain" ]] && continue
		resolve_domain_ipv4s "$domain"
	done | sort -u | emit_host_routes_from_ips "$gateway"
}

emit_domain_host_routes_from_file () {
	local domain_file="$1"
	local gateway="$2"
	local domain

	[[ ! -s "$domain_file" ]] && return

	while IFS= read -r domain; do
		domain=$(trim_spaces "$domain")
		[[ -z "$domain" || "$domain" == \#* ]] && continue
		resolve_domain_ipv4s "$domain"
	done < "$domain_file" | sort -u | emit_host_routes_from_ips "$gateway"
}

ensure_china_route_files () {
	if [[ -s "$CHINA_ROUTES_FILE" ]] && grep -qvE '^[[:space:]]*(#|$)' "$CHINA_ROUTES_FILE" \
		&& [[ -s "$CHINA_COARSE_ROUTES_FILE" ]] && grep -qvE '^[[:space:]]*(#|$)' "$CHINA_COARSE_ROUTES_FILE"; then
		return 0
	fi

	echo
	echo "China IPv4 route lists not found. Downloading the latest APNIC data..."
	if CHINA_COARSE_PREFIX="$DEFAULT_CHINA_COARSE_PREFIX" bash "$SCRIPT_DIR/update-cn-routes.sh" "$CHINA_ROUTES_FILE" "$CHINA_COARSE_ROUTES_FILE"; then
		return 0
	fi

	echo "Unable to prepare China IPv4 route files."
	echo "You can retry later with: CHINA_COARSE_PREFIX=$DEFAULT_CHINA_COARSE_PREFIX $SCRIPT_DIR/update-cn-routes.sh"
	return 1
}

prompt_client_routing_profile () {
	local default_vpn_routes="10.0.0.0/8,172.16.0.0/12,192.168.0.0/16"
	local route_mode

	echo
	echo "How should $client route traffic?"
	echo "   1) Full tunnel (all traffic through the VPN)"
	echo "   2) Split tunnel by custom CIDR"
	echo "   3) China direct / foreign through VPN (coarse client-side profile, recommended)"
	read -p "Routing mode [3]: " route_mode
	until [[ -z "$route_mode" || "$route_mode" =~ ^[123]$ ]]; do
		echo "$route_mode: invalid selection."
		read -p "Routing mode [3]: " route_mode
	done

	[[ -z "$route_mode" ]] && route_mode="3"

	if [[ "$route_mode" == "1" ]]; then
		client_routing_mode="full"
		client_vpn_routes=""
		client_local_routes=""
		client_local_domains=""
		return
	fi

	if [[ "$route_mode" == "3" ]]; then
		client_routing_mode="cn_bypass_coarse"
		client_vpn_routes=""
		if ! ensure_china_route_files; then
			exit 1
		fi

		echo
		echo "Using coarse China direct routes from: $CHINA_COARSE_ROUTES_FILE"
		echo "Default coarse prefix: /$DEFAULT_CHINA_COARSE_PREFIX"
		echo "Smaller prefix means fewer routes but broader direct coverage."
		if [[ -s "$LOCAL_DIRECT_DOMAINS_FILE" ]]; then
			echo "Common direct domains will also be loaded from: $LOCAL_DIRECT_DOMAINS_FILE"
		fi
		echo
		echo "Enter any extra CIDRs that should stay on the local gateway."
		echo "Example: 192.168.1.0/24,10.0.0.0/8"
		read -p "Extra local/direct CIDRs []: " client_local_routes
		until validate_cidr_list "$client_local_routes" true; do
			echo "$client_local_routes: invalid CIDR list."
			read -p "Extra local/direct CIDRs []: " client_local_routes
		done
		client_local_routes=$(normalize_cidr_list "$client_local_routes")

		echo
		echo "Enter any extra domains that should stay on the local gateway."
		echo "Example: baidu.com,qq.com"
		read -p "Extra local/direct domains []: " client_local_domains
		until validate_domain_list "$client_local_domains" true; do
			echo "$client_local_domains: invalid domain list."
			read -p "Extra local/direct domains []: " client_local_domains
		done
		client_local_domains=$(normalize_domain_list "$client_local_domains")
		return
	fi

	client_routing_mode="split"
	client_local_domains=""
	echo
	echo "Enter the CIDRs that should go through OpenVPN."
	read -p "VPN CIDRs [$default_vpn_routes]: " client_vpn_routes
	[[ -z "$client_vpn_routes" ]] && client_vpn_routes="$default_vpn_routes"
	until validate_cidr_list "$client_vpn_routes"; do
		echo "$client_vpn_routes: invalid CIDR list."
		read -p "VPN CIDRs [$default_vpn_routes]: " client_vpn_routes
		[[ -z "$client_vpn_routes" ]] && client_vpn_routes="$default_vpn_routes"
	done
	client_vpn_routes=$(normalize_cidr_list "$client_vpn_routes")

	echo
	echo "Enter any CIDRs that should stay on the local gateway."
	echo "Example: 192.168.1.0/24"
	read -p "Local/direct CIDRs []: " client_local_routes
	until validate_cidr_list "$client_local_routes" true; do
		echo "$client_local_routes: invalid CIDR list."
		read -p "Local/direct CIDRs []: " client_local_routes
	done
	client_local_routes=$(normalize_cidr_list "$client_local_routes")
}

select_existing_client () {
	local action="$1"
	local number_of_clients client_number

	number_of_clients=$(tail -n +2 /etc/openvpn/server/easy-rsa/pki/index.txt | grep -c "^V")
	if [[ "$number_of_clients" = 0 ]]; then
		echo
		echo "There are no existing clients!"
		return 1
	fi

	echo
	echo "Select the client to $action:"
	tail -n +2 /etc/openvpn/server/easy-rsa/pki/index.txt | grep "^V" | cut -d '=' -f 2 | nl -s ') '
	read -p "Client: " client_number
	until [[ "$client_number" =~ ^[0-9]+$ && "$client_number" -le "$number_of_clients" ]]; do
		echo "$client_number: invalid selection."
		read -p "Client: " client_number
	done

	client=$(tail -n +2 /etc/openvpn/server/easy-rsa/pki/index.txt | grep "^V" | cut -d '=' -f 2 | sed -n "$client_number"p)
	return 0
}

new_client () {
	# Generates the custom client.ovpn
	{
	cat /etc/openvpn/server/client-common.txt
	if [[ "$client_routing_mode" == "split" ]]; then
		echo
		echo "# Split tunnel: only the CIDRs below will use OpenVPN"
		echo "route-nopull"
		if [[ -n "$client_vpn_routes" ]]; then
			echo "# Traffic that should go through OpenVPN"
			emit_cidr_routes "$client_vpn_routes" "vpn_gateway"
		fi
		if [[ -n "$client_local_routes" ]]; then
			echo "# Traffic that should stay on the local gateway"
			emit_cidr_routes "$client_local_routes" "net_gateway"
		fi
	elif [[ "$client_routing_mode" == "cn_bypass_coarse" ]]; then
		echo
		echo "# Coarse China-direct split tunnel: China and local networks stay direct"
		if [[ -n "$client_local_routes" ]]; then
			echo "# Extra traffic that should stay on the local gateway"
			emit_cidr_routes "$client_local_routes" "net_gateway"
		fi
		if [[ -s "$LOCAL_DIRECT_DOMAINS_FILE" || -n "$client_local_domains" ]]; then
			echo "# Common and extra direct-domain host routes"
			if [[ -s "$LOCAL_DIRECT_DOMAINS_FILE" ]]; then
				emit_domain_host_routes_from_file "$LOCAL_DIRECT_DOMAINS_FILE" "net_gateway"
			fi
			if [[ -n "$client_local_domains" ]]; then
				emit_domain_host_routes_from_list "$client_local_domains" "net_gateway"
			fi
		fi
		echo "# Coarse Mainland China IPv4 ranges that should stay on the local gateway"
		emit_cidr_routes_from_file "$CHINA_COARSE_ROUTES_FILE" "net_gateway"
	fi
	echo "<ca>"
	cat /etc/openvpn/server/easy-rsa/pki/ca.crt
	echo "</ca>"
	echo "<cert>"
	sed -ne '/BEGIN CERTIFICATE/,$ p' /etc/openvpn/server/easy-rsa/pki/issued/"$client".crt
	echo "</cert>"
	echo "<key>"
	cat /etc/openvpn/server/easy-rsa/pki/private/"$client".key
	echo "</key>"
	echo "<tls-crypt>"
	sed -ne '/BEGIN OpenVPN Static key/,$ p' /etc/openvpn/server/tc.key
	echo "</tls-crypt>"
	} > ~/"$client".ovpn
}

if [[ ! -e /etc/openvpn/server/server.conf ]]; then
	# Detect some Debian minimal setups where neither wget nor curl are installed
	if ! hash wget 2>/dev/null && ! hash curl 2>/dev/null; then
		echo "Wget is required to use this installer."
		read -n1 -r -p "Press any key to install Wget and continue..."
		apt-get update
		apt-get install -y wget
	fi
	clear
	echo 'Welcome to this OpenVPN road warrior installer!'
	# If system has a single IPv4, it is selected automatically. Else, ask the user
	if [[ $(ip -4 addr | grep inet | grep -vEc '127(\.[0-9]{1,3}){3}') -eq 1 ]]; then
		ip=$(ip -4 addr | grep inet | grep -vE '127(\.[0-9]{1,3}){3}' | cut -d '/' -f 1 | grep -oE '[0-9]{1,3}(\.[0-9]{1,3}){3}')
	else
		number_of_ip=$(ip -4 addr | grep inet | grep -vEc '127(\.[0-9]{1,3}){3}')
		echo
		echo "Which IPv4 address should be used?"
		ip -4 addr | grep inet | grep -vE '127(\.[0-9]{1,3}){3}' | cut -d '/' -f 1 | grep -oE '[0-9]{1,3}(\.[0-9]{1,3}){3}' | nl -s ') '
		read -p "IPv4 address [1]: " ip_number
		until [[ -z "$ip_number" || "$ip_number" =~ ^[0-9]+$ && "$ip_number" -le "$number_of_ip" ]]; do
			echo "$ip_number: invalid selection."
			read -p "IPv4 address [1]: " ip_number
		done
		[[ -z "$ip_number" ]] && ip_number="1"
		ip=$(ip -4 addr | grep inet | grep -vE '127(\.[0-9]{1,3}){3}' | cut -d '/' -f 1 | grep -oE '[0-9]{1,3}(\.[0-9]{1,3}){3}' | sed -n "$ip_number"p)
	fi
	# If $ip is a private IP address, the server must be behind NAT
	if echo "$ip" | grep -qE '^(10\.|172\.1[6789]\.|172\.2[0-9]\.|172\.3[01]\.|192\.168)'; then
		echo
		echo "This server is behind NAT. What is the public IPv4 address or hostname?"
		# Get public IP and sanitize with grep
		get_public_ip=$(grep -m 1 -oE '^[0-9]{1,3}(\.[0-9]{1,3}){3}$' <<< "$(wget -T 10 -t 1 -4qO- "http://ip1.dynupdate.no-ip.com/" || curl -m 10 -4Ls "http://ip1.dynupdate.no-ip.com/")")
		read -p "Public IPv4 address / hostname [$get_public_ip]: " public_ip
		# If the checkip service is unavailable and user didn't provide input, ask again
		until [[ -n "$get_public_ip" || -n "$public_ip" ]]; do
			echo "Invalid input."
			read -p "Public IPv4 address / hostname: " public_ip
		done
		[[ -z "$public_ip" ]] && public_ip="$get_public_ip"
	fi
	# If system has a single IPv6, it is selected automatically
	if [[ $(ip -6 addr | grep -c 'inet6 [23]') -eq 1 ]]; then
		ip6=$(ip -6 addr | grep 'inet6 [23]' | cut -d '/' -f 1 | grep -oE '([0-9a-fA-F]{0,4}:){1,7}[0-9a-fA-F]{0,4}')
	fi
	# If system has multiple IPv6, ask the user to select one
	if [[ $(ip -6 addr | grep -c 'inet6 [23]') -gt 1 ]]; then
		number_of_ip6=$(ip -6 addr | grep -c 'inet6 [23]')
		echo
		echo "Which IPv6 address should be used?"
		ip -6 addr | grep 'inet6 [23]' | cut -d '/' -f 1 | grep -oE '([0-9a-fA-F]{0,4}:){1,7}[0-9a-fA-F]{0,4}' | nl -s ') '
		read -p "IPv6 address [1]: " ip6_number
		until [[ -z "$ip6_number" || "$ip6_number" =~ ^[0-9]+$ && "$ip6_number" -le "$number_of_ip6" ]]; do
			echo "$ip6_number: invalid selection."
			read -p "IPv6 address [1]: " ip6_number
		done
		[[ -z "$ip6_number" ]] && ip6_number="1"
		ip6=$(ip -6 addr | grep 'inet6 [23]' | cut -d '/' -f 1 | grep -oE '([0-9a-fA-F]{0,4}:){1,7}[0-9a-fA-F]{0,4}' | sed -n "$ip6_number"p)
	fi
	echo
	echo "Which protocol should OpenVPN use?"
	echo "   1) UDP (recommended)"
	echo "   2) TCP"
	read -p "Protocol [1]: " protocol
	until [[ -z "$protocol" || "$protocol" =~ ^[12]$ ]]; do
		echo "$protocol: invalid selection."
		read -p "Protocol [1]: " protocol
	done
	case "$protocol" in
		1|"") 
		protocol=udp
		;;
		2) 
		protocol=tcp
		;;
	esac
	echo
	echo "What port should OpenVPN listen to?"
	read -p "Port [334]: " port
	until [[ -z "$port" || "$port" =~ ^[0-9]+$ && "$port" -le 65535 ]]; do
		echo "$port: invalid port."
		read -p "Port [334]: " port
	done
	[[ -z "$port" ]] && port="334"
	echo
	echo "Select a DNS server for the clients:"
	echo "   1) Current system resolvers"
	echo "   2) Google"
	echo "   3) 1.1.1.1"
	echo "   4) OpenDNS"
	echo "   5) Quad9"
	echo "   6) AdGuard"
	read -p "DNS server [1]: " dns
	until [[ -z "$dns" || "$dns" =~ ^[1-6]$ ]]; do
		echo "$dns: invalid selection."
		read -p "DNS server [1]: " dns
	done
	echo
	echo "Enter a name for the first client:"
	read -p "Name [client]: " unsanitized_client
	# Allow a limited set of characters to avoid conflicts
	client=$(sed 's/[^0123456789abcdefghijklmnopqrstuvwxyzABCDEFGHIJKLMNOPQRSTUVWXYZ_-]/_/g' <<< "$unsanitized_client")
	[[ -z "$client" ]] && client="client"
	prompt_client_routing_profile
	echo
	echo "OpenVPN installation is ready to begin."
	# Install a firewall if firewalld or iptables are not already available
	if ! systemctl is-active --quiet firewalld.service && ! hash iptables 2>/dev/null; then
		if [[ "$os" == "centos" || "$os" == "fedora" ]]; then
			firewall="firewalld"
			# We don't want to silently enable firewalld, so we give a subtle warning
			# If the user continues, firewalld will be installed and enabled during setup
			echo "firewalld, which is required to manage routing tables, will also be installed."
		elif [[ "$os" == "debian" || "$os" == "ubuntu" ]]; then
			# iptables is way less invasive than firewalld so no warning is given
			firewall="iptables"
		fi
	fi
	read -n1 -r -p "Press any key to continue..."
	# If running inside a container, disable LimitNPROC to prevent conflicts
	if systemd-detect-virt -cq; then
		mkdir /etc/systemd/system/openvpn-server@server.service.d/ 2>/dev/null
		echo "[Service]
LimitNPROC=infinity" > /etc/systemd/system/openvpn-server@server.service.d/disable-limitnproc.conf
	fi
	if [[ "$os" = "debian" || "$os" = "ubuntu" ]]; then
		apt-get update
		apt-get install -y --no-install-recommends openvpn openssl ca-certificates $firewall
	elif [[ "$os" = "centos" ]]; then
		yum install -y epel-release
		yum install -y openvpn openssl ca-certificates tar $firewall
	else
		# Else, OS must be Fedora
		dnf install -y openvpn openssl ca-certificates tar $firewall
	fi
	# If firewalld was just installed, enable it
	if [[ "$firewall" == "firewalld" ]]; then
		systemctl enable --now firewalld.service
	fi
	# Get easy-rsa
	easy_rsa_url='https://github.com/OpenVPN/easy-rsa/releases/download/v3.1.7/EasyRSA-3.1.7.tgz'
	mkdir -p /etc/openvpn/server/easy-rsa/
	{ wget -qO- "$easy_rsa_url" 2>/dev/null || curl -sL "$easy_rsa_url" ; } | tar xz -C /etc/openvpn/server/easy-rsa/ --strip-components 1
	chown -R root:root /etc/openvpn/server/easy-rsa/
	cd /etc/openvpn/server/easy-rsa/
	# Create the PKI, set up the CA and the server and client certificates
	./easyrsa --batch init-pki
	./easyrsa --batch build-ca nopass
	./easyrsa --batch --days=3650 build-server-full server nopass
	./easyrsa --batch --days=3650 build-client-full "$client" nopass
	./easyrsa --batch --days=3650 gen-crl
	# Move the stuff we need
	cp pki/ca.crt pki/private/ca.key pki/issued/server.crt pki/private/server.key pki/crl.pem /etc/openvpn/server
	# CRL is read with each client connection, while OpenVPN is dropped to nobody
	chown nobody:"$group_name" /etc/openvpn/server/crl.pem
	# Without +x in the directory, OpenVPN can't run a stat() on the CRL file
	chmod o+x /etc/openvpn/server/
	# Generate key for tls-crypt
	openvpn --genkey --secret /etc/openvpn/server/tc.key
	# Create the DH parameters file using the predefined ffdhe2048 group
	echo '-----BEGIN DH PARAMETERS-----
MIIBCAKCAQEA//////////+t+FRYortKmq/cViAnPTzx2LnFg84tNpWp4TZBFGQz
+8yTnc4kmz75fS/jY2MMddj2gbICrsRhetPfHtXV/WVhJDP1H18GbtCFY2VVPe0a
87VXE15/V8k1mE8McODmi3fipona8+/och3xWKE2rec1MKzKT0g6eXq8CrGCsyT7
YdEIqUuyyOP7uWrat2DX9GgdT0Kj3jlN9K5W7edjcrsZCwenyO4KbXCeAvzhzffi
7MA0BM0oNC9hkXL+nOmFg/+OTxIy7vKBg8P+OxtMb61zO7X8vC7CIAXFjvGDfRaD
ssbzSibBsu/6iGtCOGEoXJf//////////wIBAg==
-----END DH PARAMETERS-----' > /etc/openvpn/server/dh.pem
	# Generate server.conf
	echo "local $ip
port $port
proto $protocol
dev tun
ca ca.crt
cert server.crt
key server.key
dh dh.pem
auth SHA512
tls-crypt tc.key
topology subnet
server 10.8.0.0 255.255.255.0" > /etc/openvpn/server/server.conf
	# IPv6
	if [[ -z "$ip6" ]]; then
		echo 'push "redirect-gateway def1 bypass-dhcp"' >> /etc/openvpn/server/server.conf
	else
		echo 'server-ipv6 fddd:1194:1194:1194::/64' >> /etc/openvpn/server/server.conf
		echo 'push "redirect-gateway def1 ipv6 bypass-dhcp"' >> /etc/openvpn/server/server.conf
	fi
	echo 'ifconfig-pool-persist ipp.txt' >> /etc/openvpn/server/server.conf
	# DNS
	case "$dns" in
		1|"")
			# Locate the proper resolv.conf
			# Needed for systems running systemd-resolved
			if grep '^nameserver' "/etc/resolv.conf" | grep -qv '127.0.0.53' ; then
				resolv_conf="/etc/resolv.conf"
			else
				resolv_conf="/run/systemd/resolve/resolv.conf"
			fi
			# Obtain the resolvers from resolv.conf and use them for OpenVPN
			grep -v '^#\|^;' "$resolv_conf" | grep '^nameserver' | grep -v '127.0.0.53' | grep -oE '[0-9]{1,3}(\.[0-9]{1,3}){3}' | while read line; do
				echo "push \"dhcp-option DNS $line\"" >> /etc/openvpn/server/server.conf
			done
		;;
		2)
			echo 'push "dhcp-option DNS 8.8.8.8"' >> /etc/openvpn/server/server.conf
			echo 'push "dhcp-option DNS 8.8.4.4"' >> /etc/openvpn/server/server.conf
		;;
		3)
			echo 'push "dhcp-option DNS 1.1.1.1"' >> /etc/openvpn/server/server.conf
			echo 'push "dhcp-option DNS 1.0.0.1"' >> /etc/openvpn/server/server.conf
		;;
		4)
			echo 'push "dhcp-option DNS 208.67.222.222"' >> /etc/openvpn/server/server.conf
			echo 'push "dhcp-option DNS 208.67.220.220"' >> /etc/openvpn/server/server.conf
		;;
		5)
			echo 'push "dhcp-option DNS 9.9.9.9"' >> /etc/openvpn/server/server.conf
			echo 'push "dhcp-option DNS 149.112.112.112"' >> /etc/openvpn/server/server.conf
		;;
		6)
			echo 'push "dhcp-option DNS 94.140.14.14"' >> /etc/openvpn/server/server.conf
			echo 'push "dhcp-option DNS 94.140.15.15"' >> /etc/openvpn/server/server.conf
		;;
	esac
	echo 'push "block-outside-dns"' >> /etc/openvpn/server/server.conf
	echo "keepalive 10 120
user nobody
group $group_name
persist-key
persist-tun
verb 3
crl-verify crl.pem" >> /etc/openvpn/server/server.conf
	if [[ "$protocol" = "udp" ]]; then
		echo "explicit-exit-notify" >> /etc/openvpn/server/server.conf
	fi
	# Enable net.ipv4.ip_forward for the system
	echo 'net.ipv4.ip_forward=1' > /etc/sysctl.d/99-openvpn-forward.conf
	# Enable without waiting for a reboot or service restart
	echo 1 > /proc/sys/net/ipv4/ip_forward
	if [[ -n "$ip6" ]]; then
		# Enable net.ipv6.conf.all.forwarding for the system
		echo "net.ipv6.conf.all.forwarding=1" >> /etc/sysctl.d/99-openvpn-forward.conf
		# Enable without waiting for a reboot or service restart
		echo 1 > /proc/sys/net/ipv6/conf/all/forwarding
	fi
	if systemctl is-active --quiet firewalld.service; then
		# Using both permanent and not permanent rules to avoid a firewalld
		# reload.
		# We don't use --add-service=openvpn because that would only work with
		# the default port and protocol.
		firewall-cmd --add-port="$port"/"$protocol"
		firewall-cmd --zone=trusted --add-source=10.8.0.0/24
		firewall-cmd --permanent --add-port="$port"/"$protocol"
		firewall-cmd --permanent --zone=trusted --add-source=10.8.0.0/24
		# Set NAT for the VPN subnet
		firewall-cmd --direct --add-rule ipv4 nat POSTROUTING 0 -s 10.8.0.0/24 ! -d 10.8.0.0/24 -j SNAT --to "$ip"
		firewall-cmd --permanent --direct --add-rule ipv4 nat POSTROUTING 0 -s 10.8.0.0/24 ! -d 10.8.0.0/24 -j SNAT --to "$ip"
		if [[ -n "$ip6" ]]; then
			firewall-cmd --zone=trusted --add-source=fddd:1194:1194:1194::/64
			firewall-cmd --permanent --zone=trusted --add-source=fddd:1194:1194:1194::/64
			firewall-cmd --direct --add-rule ipv6 nat POSTROUTING 0 -s fddd:1194:1194:1194::/64 ! -d fddd:1194:1194:1194::/64 -j SNAT --to "$ip6"
			firewall-cmd --permanent --direct --add-rule ipv6 nat POSTROUTING 0 -s fddd:1194:1194:1194::/64 ! -d fddd:1194:1194:1194::/64 -j SNAT --to "$ip6"
		fi
	else
		# Create a service to set up persistent iptables rules
		iptables_path=$(command -v iptables)
		ip6tables_path=$(command -v ip6tables)
		# nf_tables is not available as standard in OVZ kernels. So use iptables-legacy
		# if we are in OVZ, with a nf_tables backend and iptables-legacy is available.
		if [[ $(systemd-detect-virt) == "openvz" ]] && readlink -f "$(command -v iptables)" | grep -q "nft" && hash iptables-legacy 2>/dev/null; then
			iptables_path=$(command -v iptables-legacy)
			ip6tables_path=$(command -v ip6tables-legacy)
		fi
		echo "[Unit]
Before=network.target
[Service]
Type=oneshot
ExecStart=$iptables_path -t nat -A POSTROUTING -s 10.8.0.0/24 ! -d 10.8.0.0/24 -j SNAT --to $ip
ExecStart=$iptables_path -I INPUT -p $protocol --dport $port -j ACCEPT
ExecStart=$iptables_path -I FORWARD -s 10.8.0.0/24 -j ACCEPT
ExecStart=$iptables_path -I FORWARD -m state --state RELATED,ESTABLISHED -j ACCEPT
ExecStop=$iptables_path -t nat -D POSTROUTING -s 10.8.0.0/24 ! -d 10.8.0.0/24 -j SNAT --to $ip
ExecStop=$iptables_path -D INPUT -p $protocol --dport $port -j ACCEPT
ExecStop=$iptables_path -D FORWARD -s 10.8.0.0/24 -j ACCEPT
ExecStop=$iptables_path -D FORWARD -m state --state RELATED,ESTABLISHED -j ACCEPT" > /etc/systemd/system/openvpn-iptables.service
		if [[ -n "$ip6" ]]; then
			echo "ExecStart=$ip6tables_path -t nat -A POSTROUTING -s fddd:1194:1194:1194::/64 ! -d fddd:1194:1194:1194::/64 -j SNAT --to $ip6
ExecStart=$ip6tables_path -I FORWARD -s fddd:1194:1194:1194::/64 -j ACCEPT
ExecStart=$ip6tables_path -I FORWARD -m state --state RELATED,ESTABLISHED -j ACCEPT
ExecStop=$ip6tables_path -t nat -D POSTROUTING -s fddd:1194:1194:1194::/64 ! -d fddd:1194:1194:1194::/64 -j SNAT --to $ip6
ExecStop=$ip6tables_path -D FORWARD -s fddd:1194:1194:1194::/64 -j ACCEPT
ExecStop=$ip6tables_path -D FORWARD -m state --state RELATED,ESTABLISHED -j ACCEPT" >> /etc/systemd/system/openvpn-iptables.service
		fi
		echo "RemainAfterExit=yes
[Install]
WantedBy=multi-user.target" >> /etc/systemd/system/openvpn-iptables.service
		systemctl enable --now openvpn-iptables.service
	fi
	# If SELinux is enabled and a custom port was selected, we need this
	if sestatus 2>/dev/null | grep "Current mode" | grep -q "enforcing" && [[ "$port" != 1194 ]]; then
		# Install semanage if not already present
		if ! hash semanage 2>/dev/null; then
			if [[ "$os_version" -eq 7 ]]; then
				# Centos 7
				yum install -y policycoreutils-python
			else
				# CentOS 8 or Fedora
				dnf install -y policycoreutils-python-utils
			fi
		fi
		semanage port -a -t openvpn_port_t -p "$protocol" "$port"
	fi
	# If the server is behind NAT, use the correct IP address
	[[ -n "$public_ip" ]] && ip="$public_ip"
	# client-common.txt is created so we have a template to add further users later
	echo "client
dev tun
proto $protocol
remote $ip $port
resolv-retry infinite
nobind
persist-key
persist-tun
remote-cert-tls server
auth SHA512
ignore-unknown-option block-outside-dns
verb 3" > /etc/openvpn/server/client-common.txt
	# Enable and start the OpenVPN service
	systemctl enable --now openvpn-server@server.service
	# Generates the custom client.ovpn
	new_client
	echo
	echo "Finished!"
	echo
	echo "The client configuration is available in:" ~/"$client.ovpn"
	echo "New clients can be added by running this script again."
else
	clear
	echo "OpenVPN is already installed."
	echo
	echo "Select an option:"
	echo "   1) Add a new client"
	echo "   2) Revoke an existing client"
	echo "   3) Regenerate an existing client config"
	echo "   4) Remove OpenVPN"
	echo "   5) Exit"
	read -p "Option: " option
	until [[ "$option" =~ ^[1-5]$ ]]; do
		echo "$option: invalid selection."
		read -p "Option: " option
	done
	case "$option" in
		1)
			echo
			echo "Provide a name for the client:"
			read -p "Name: " unsanitized_client
			client=$(sed 's/[^0123456789abcdefghijklmnopqrstuvwxyzABCDEFGHIJKLMNOPQRSTUVWXYZ_-]/_/g' <<< "$unsanitized_client")
			while [[ -z "$client" || -e /etc/openvpn/server/easy-rsa/pki/issued/"$client".crt ]]; do
				echo "$client: invalid name."
				read -p "Name: " unsanitized_client
				client=$(sed 's/[^0123456789abcdefghijklmnopqrstuvwxyzABCDEFGHIJKLMNOPQRSTUVWXYZ_-]/_/g' <<< "$unsanitized_client")
			done
			prompt_client_routing_profile
			cd /etc/openvpn/server/easy-rsa/
			./easyrsa --batch --days=3650 build-client-full "$client" nopass
			# Generates the custom client.ovpn
			new_client
			echo
			echo "$client added. Configuration available in:" ~/"$client.ovpn"
			exit
		;;
		2)
			# This option could be documented a bit better and maybe even be simplified
			# ...but what can I say, I want some sleep too
			select_existing_client "revoke" || exit
			echo
			read -p "Confirm $client revocation? [y/N]: " revoke
			until [[ "$revoke" =~ ^[yYnN]*$ ]]; do
				echo "$revoke: invalid selection."
				read -p "Confirm $client revocation? [y/N]: " revoke
			done
			if [[ "$revoke" =~ ^[yY]$ ]]; then
				cd /etc/openvpn/server/easy-rsa/
				./easyrsa --batch revoke "$client"
				./easyrsa --batch --days=3650 gen-crl
				rm -f /etc/openvpn/server/crl.pem
				cp /etc/openvpn/server/easy-rsa/pki/crl.pem /etc/openvpn/server/crl.pem
				# CRL is read with each client connection, when OpenVPN is dropped to nobody
				chown nobody:"$group_name" /etc/openvpn/server/crl.pem
				echo
				echo "$client revoked!"
			else
				echo
				echo "$client revocation aborted!"
			fi
			exit
		;;
		3)
			select_existing_client "regenerate" || exit
			prompt_client_routing_profile
			new_client
			echo
			echo "$client configuration regenerated in:" ~/"$client.ovpn"
			exit
		;;
		4)
			echo
			read -p "Confirm OpenVPN removal? [y/N]: " remove
			until [[ "$remove" =~ ^[yYnN]*$ ]]; do
				echo "$remove: invalid selection."
				read -p "Confirm OpenVPN removal? [y/N]: " remove
			done
			if [[ "$remove" =~ ^[yY]$ ]]; then
				port=$(grep '^port ' /etc/openvpn/server/server.conf | cut -d " " -f 2)
				protocol=$(grep '^proto ' /etc/openvpn/server/server.conf | cut -d " " -f 2)
				if systemctl is-active --quiet firewalld.service; then
					ip=$(firewall-cmd --direct --get-rules ipv4 nat POSTROUTING | grep '\-s 10.8.0.0/24 '"'"'!'"'"' -d 10.8.0.0/24' | grep -oE '[^ ]+$')
					# Using both permanent and not permanent rules to avoid a firewalld reload.
					firewall-cmd --remove-port="$port"/"$protocol"
					firewall-cmd --zone=trusted --remove-source=10.8.0.0/24
					firewall-cmd --permanent --remove-port="$port"/"$protocol"
					firewall-cmd --permanent --zone=trusted --remove-source=10.8.0.0/24
					firewall-cmd --direct --remove-rule ipv4 nat POSTROUTING 0 -s 10.8.0.0/24 ! -d 10.8.0.0/24 -j SNAT --to "$ip"
					firewall-cmd --permanent --direct --remove-rule ipv4 nat POSTROUTING 0 -s 10.8.0.0/24 ! -d 10.8.0.0/24 -j SNAT --to "$ip"
					if grep -qs "server-ipv6" /etc/openvpn/server/server.conf; then
						ip6=$(firewall-cmd --direct --get-rules ipv6 nat POSTROUTING | grep '\-s fddd:1194:1194:1194::/64 '"'"'!'"'"' -d fddd:1194:1194:1194::/64' | grep -oE '[^ ]+$')
						firewall-cmd --zone=trusted --remove-source=fddd:1194:1194:1194::/64
						firewall-cmd --permanent --zone=trusted --remove-source=fddd:1194:1194:1194::/64
						firewall-cmd --direct --remove-rule ipv6 nat POSTROUTING 0 -s fddd:1194:1194:1194::/64 ! -d fddd:1194:1194:1194::/64 -j SNAT --to "$ip6"
						firewall-cmd --permanent --direct --remove-rule ipv6 nat POSTROUTING 0 -s fddd:1194:1194:1194::/64 ! -d fddd:1194:1194:1194::/64 -j SNAT --to "$ip6"
					fi
				else
					systemctl disable --now openvpn-iptables.service
					rm -f /etc/systemd/system/openvpn-iptables.service
				fi
				if sestatus 2>/dev/null | grep "Current mode" | grep -q "enforcing" && [[ "$port" != 1194 ]]; then
					semanage port -d -t openvpn_port_t -p "$protocol" "$port"
				fi
				systemctl disable --now openvpn-server@server.service
				rm -f /etc/systemd/system/openvpn-server@server.service.d/disable-limitnproc.conf
				rm -f /etc/sysctl.d/99-openvpn-forward.conf
				if [[ "$os" = "debian" || "$os" = "ubuntu" ]]; then
					rm -rf /etc/openvpn/server
					apt-get remove --purge -y openvpn
				else
					# Else, OS must be CentOS or Fedora
					yum remove -y openvpn
					rm -rf /etc/openvpn/server
				fi
				echo
				echo "OpenVPN removed!"
			else
				echo
				echo "OpenVPN removal aborted!"
			fi
			exit
		;;
		5)
			exit
		;;
	esac
fi
