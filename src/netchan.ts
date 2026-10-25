// Client side of qcommon/net_chan.c plus the message obfuscation from client/cl_net_chan.c.
import { MsgReader, MAX_MSGLEN } from './msg.js';

export const MAX_PACKETLEN = 1400;
export const FRAGMENT_SIZE = MAX_PACKETLEN - 100;
const FRAGMENT_BIT = 0x80000000;

export const MAX_RELIABLE_COMMANDS = 256;

export class Netchan {
	incomingSequence = 0;
	outgoingSequence = 1;
	dropped = 0;
	private fragmentSequence = 0;
	private fragmentLength = 0;
	private readonly fragmentBuffer = Buffer.alloc(MAX_MSGLEN);

	constructor(readonly qport: number) {}

	/** Wraps a message into one or more datagrams (Netchan_Transmit). */
	transmit(data: Uint8Array): Buffer[] {
		const packets: Buffer[] = [];
		const total = data.length;
		if (total > MAX_MSGLEN) throw new RangeError(`Netchan.transmit: length = ${total}`);

		if (total < FRAGMENT_SIZE) {
			const p = Buffer.alloc(6 + total);
			p.writeInt32LE(this.outgoingSequence++, 0);
			p.writeUInt16LE(this.qport & 0xffff, 4);
			p.set(data, 6);
			return [p];
		}

		let start = 0;
		let len: number;
		do {
			len = Math.min(FRAGMENT_SIZE, total - start);
			const p = Buffer.alloc(10 + len);
			p.writeUInt32LE((this.outgoingSequence | FRAGMENT_BIT) >>> 0, 0);
			p.writeUInt16LE(this.qport & 0xffff, 4);
			p.writeUInt16LE(start, 6);
			p.writeUInt16LE(len, 8);
			p.set(data.subarray(start, start + len), 10);
			packets.push(p);
			start += len;
		} while (!(start === total && len !== FRAGMENT_SIZE));
		this.outgoingSequence++;
		return packets;
	}

	/**
	 * Netchan_Process. Returns the complete message laid out as [sequence:int32][payload],
	 * or null if the packet is stale, a duplicate, or an incomplete fragment.
	 */
	process(packet: Buffer): Buffer | null {
		if (packet.length < 4) return null;
		let sequence = packet.readInt32LE(0);
		const fragmented = (sequence & FRAGMENT_BIT) !== 0;
		if (fragmented) sequence &= ~FRAGMENT_BIT;

		let fragmentStart = 0;
		let fragmentLength = 0;
		let offset = 4;
		if (fragmented) {
			if (packet.length < 8) return null;
			fragmentStart = packet.readInt16LE(4);
			fragmentLength = packet.readInt16LE(6);
			offset = 8;
		}

		if (sequence <= this.incomingSequence) return null;
		this.dropped = sequence - (this.incomingSequence + 1);

		if (!fragmented) {
			this.incomingSequence = sequence;
			return packet;
		}

		if (sequence !== this.fragmentSequence) {
			this.fragmentSequence = sequence;
			this.fragmentLength = 0;
		}
		if (fragmentStart !== this.fragmentLength) return null;
		if (
			fragmentLength < 0 ||
			offset + fragmentLength > packet.length ||
			this.fragmentLength + fragmentLength > this.fragmentBuffer.length
		) {
			return null;
		}

		packet.copy(this.fragmentBuffer, this.fragmentLength, offset, offset + fragmentLength);
		this.fragmentLength += fragmentLength;
		if (fragmentLength === FRAGMENT_SIZE) return null;

		const out = Buffer.alloc(4 + this.fragmentLength);
		out.writeInt32LE(sequence, 0);
		this.fragmentBuffer.copy(out, 4, 0, this.fragmentLength);
		this.fragmentLength = 0;
		this.incomingSequence = sequence;
		return out;
	}
}

function commandKeyByte(key: number, ch: number, i: number): number {
	// '%' and non-ASCII bytes are sent as '.' on the wire, so they key as '.'
	const c = ch > 127 || ch === 0x25 ? 0x2e : ch;
	return (key ^ (c << (i & 1))) & 0xff;
}

function xorWithCommand(data: Uint8Array, from: number, to: number, key: number, command: string): void {
	let index = 0;
	for (let i = from; i < to; i++) {
		if (index >= command.length) index = 0;
		const ch = index < command.length ? command.charCodeAt(index) : 0;
		key = commandKeyByte(key, ch, i);
		index++;
		data[i] ^= key;
	}
}

const CL_ENCODE_START = 12;
const CL_DECODE_START = 4;

/**
 * CL_Netchan_Encode: obfuscates a client message in place before it is handed to the netchan.
 * `serverCommands` is indexed by the reliableAcknowledge value found in the message header.
 */
export function encodeClientMessage(
	data: Uint8Array,
	cursize: number,
	challenge: number,
	serverCommands: readonly string[],
): void {
	if (cursize <= CL_ENCODE_START) return;
	const r = new MsgReader(data.subarray(0, cursize));
	const serverId = r.readLong();
	const messageAcknowledge = r.readLong();
	const reliableAcknowledge = r.readLong();
	const command = serverCommands[reliableAcknowledge & (MAX_RELIABLE_COMMANDS - 1)] ?? '';
	const key = (challenge ^ serverId ^ messageAcknowledge) & 0xff;
	xorWithCommand(data, CL_ENCODE_START, cursize, key, command);
}

/**
 * CL_Netchan_Decode: de-obfuscates a server message in place. `msg` is [sequence][payload]
 * as returned by Netchan.process; `clientCommands` are the commands this client has sent.
 */
export function decodeServerMessage(msg: Buffer, challenge: number, clientCommands: readonly string[]): void {
	const r = new MsgReader(msg, 32);
	const reliableAcknowledge = r.readLong();
	const command = clientCommands[reliableAcknowledge & (MAX_RELIABLE_COMMANDS - 1)] ?? '';
	const key = (challenge ^ msg.readInt32LE(0)) & 0xff;
	xorWithCommand(msg, 4 + CL_DECODE_START, msg.length, key, command);
}
