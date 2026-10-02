#!/usr/bin/env python3
"""Passive TCP header timing only; never stores packet payload or camera keys.

Requires root/CAP_NET_RAW. Does not enable promiscuous mode. Uses kernel receive
timestamps when available; receive-side buffering/GSO still limit interpretation.
"""
import argparse
import json
import socket
import statistics
import struct
import time

parser = argparse.ArgumentParser(description=__doc__)
parser.add_argument('--interface', default='ens18')
parser.add_argument('--destination', default='168.194.15.218')
parser.add_argument('--source',help='Optional source IPv4 filter')
parser.add_argument('--port-side',choices=['source','destination'],default='destination')
parser.add_argument('--port', type=int, default=1935)
parser.add_argument('--seconds', type=int, default=30)
args = parser.parse_args()
target = socket.inet_aton(args.destination) if args.destination!='any' else None
source = socket.inet_aton(args.source) if args.source else None
if target is None and source is None:parser.error('At least one IP filter required')
sock = socket.socket(socket.AF_PACKET, socket.SOCK_RAW, socket.htons(0x0003))
if args.interface!='any':sock.bind((args.interface, 0))
sock.settimeout(1)
stamp_option = getattr(socket, 'SO_TIMESTAMPNS', 35)
sock.setsockopt(socket.SOL_SOCKET, stamp_option, 1)
selected = None
arrivals = []
payload_bytes = 0
deadline = time.monotonic() + args.seconds
try:
    while time.monotonic() < deadline:
        try:
            packet, control, _, _ = sock.recvmsg(96, 128)
        except socket.timeout:
            continue
        if len(packet) < 54 or packet[12:14] != b'\x08\x00' or packet[23] != 6:
            continue
        if (target is not None and packet[30:34]!=target) or (source is not None and packet[26:30]!=source):
            continue
        ip_header = (packet[14] & 15) * 4
        tcp = 14 + ip_header
        if len(packet) < tcp + 20:
            continue
        source_port, destination_port = struct.unpack_from('!HH', packet, tcp)
        if (destination_port if args.port_side=='destination' else source_port)!=args.port:
            continue
        length = struct.unpack_from('!H', packet, 16)[0] - ip_header - ((packet[tcp + 12] >> 4) * 4)
        if length <= 0:
            continue
        flow=(source_port,destination_port)
        if selected is None:
            selected = flow
        if flow != selected:
            continue
        for level, kind, value in control:
            if level == socket.SOL_SOCKET and kind == stamp_option:
                seconds, nanos = struct.unpack('ll', value[:16])
                arrivals.append(seconds + nanos / 1e9)
                payload_bytes += length
                break
finally:
    sock.close()
gaps = [(b-a)*1000 for a,b in zip(arrivals, arrivals[1:])]
pauses = sorted(x for x in gaps if x > 20)
print(json.dumps({'seconds': args.seconds, 'sample_valid': len(arrivals)>1, 'packets_with_payload': len(arrivals), 'tcp_payload_bytes': payload_bytes,
                  'selected_source_port': selected[0] if selected else None,
                  'selected_destination_port': selected[1] if selected else None,'pauses_over_20ms': len(pauses),
                  'pause_median_ms': round(statistics.median(pauses), 3) if pauses else None,
                  'pause_p95_ms': round(pauses[int((len(pauses)-1)*.95)], 3) if pauses else None,
                  'max_gap_ms': round(max(gaps), 3) if gaps else None,
                  'pauses_over_400ms': sum(x > 400 for x in gaps),
                  'sample_pauses_ms': [round(x, 2) for x in pauses[:10]]}))
