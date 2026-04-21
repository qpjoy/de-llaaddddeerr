#!/bin/bash

TC=/sbin/tc
IF=tun0
LIMIT=10mbit
START_RATE=1mbit
CHILD_LIMIT=3mbit
MAX_LIMIT=9mbit
MID_LIMIT=6mbit


DST_CIDR11=10.8.0.14/32
DST_CIDR10=10.8.0.10/32
DST_CIDR9=10.8.0.9/32
DST_CIDR8=10.8.0.8/32
DST_CIDR7=10.8.0.7/32
DST_CIDR6=10.8.0.6/32
DST_CIDR5=10.8.0.5/32
DST_CIDR4=10.8.0.4/32
DST_CIDR3=10.8.0.3/32
DST_CIDR2=10.8.0.2/32

U32="$TC filter add dev $IF protocol ip parent 1:0 prio 1 u32"

mark () {
  echo "== TODO: MARKING FLOW =="
#   iptables -t mangle -A PREROUTING -i ens33 -s/-d DST_CIDR -j MARK --or-mark 1
#   -m iprange --dst-range
}

create () {
  echo "== SHAPING INIT =="

  # root
  $TC qdisc add dev $IF root handle 1:0 htb default 40

  # parent
  $TC class add dev $IF parent 1:0 classid 1:1 htb rate $LIMIT ceil $LIMIT

  # children (leafs)
  $TC class add dev $IF parent 1:1 classid 1:10 htb rate $START_RATE ceil $MAX_LIMIT
  $TC class add dev $IF parent 1:1 classid 1:20 htb rate $START_RATE ceil $LIMIT
  $TC class add dev $IF parent 1:1 classid 1:30 htb rate $START_RATE ceil $MAX_LIMIT
  $TC class add dev $IF parent 1:1 classid 1:40 htb rate $START_RATE ceil $MID_LIMIT
  $TC class add dev $IF parent 1:1 classid 1:50 htb rate $START_RATE ceil $MID_LIMIT
  $TC class add dev $IF parent 1:1 classid 1:60 htb rate $START_RATE ceil $MID_LIMIT
  $TC class add dev $IF parent 1:1 classid 1:70 htb rate $START_RATE ceil $MID_LIMIT
  $TC class add dev $IF parent 1:1 classid 1:80 htb rate $START_RATE ceil $MID_LIMIT
  $TC class add dev $IF parent 1:1 classid 1:90 htb rate $START_RATE ceil $MID_LIMIT
  $TC class add dev $IF parent 1:1 classid 1:101 htb rate $START_RATE ceil $CHILD_LIMIT

  $U32 match ip dst $DST_CIDR2 flowid 1:10
  $U32 match ip dst $DST_CIDR3 flowid 1:20
  $U32 match ip dst $DST_CIDR4 flowid 1:30
  $U32 match ip dst $DST_CIDR5 flowid 1:40
  $U32 match ip dst $DST_CIDR6 flowid 1:50
  $U32 match ip dst $DST_CIDR7 flowid 1:60
  $U32 match ip dst $DST_CIDR8 flowid 1:70
  $U32 match ip dst $DST_CIDR9 flowid 1:80
  $U32 match ip dst $DST_CIDR10 flowid 1:90
  $U32 match ip dst $DST_CIDR11 flowid 1:101

  echo "== SHAPING DONE =="
}

clean () {
    echo "== CLEAN INIT =="
    $TC qdisc del dev $IF root 2>/dev/null || true  # 这一行就够了
    # $TC class del dev $IF root
    # $TC qdisc del dev $IF ingress
    echo "== CLEAN DONE =="
}

clean
create