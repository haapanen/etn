// Connectionless ("out of band") packets: 0xffffffff header followed by a text command.
import { huffCompress } from './huffman.js';
import { tokenize } from './text.js';

export const OOB_HEADER = Buffer.from([0xff, 0xff, 0xff, 0xff]);

export function isOOB(buf: Buffer): boolean {
	return buf.length >= 4 && buf.readInt32LE(0) === -1;
}

export function encodeOOB(text: string): Buffer {
	return Buffer.concat([OOB_HEADER, Buffer.from(text, 'latin1')]);
}

/** The `connect "<userinfo>"` packet: everything after "connect " is Huffman compressed. */
export function encodeConnectPacket(userinfo: string): Buffer {
	const prefix = Buffer.concat([OOB_HEADER, Buffer.from('connect ', 'latin1')]);
	const body = Buffer.from(`"${userinfo}"`, 'latin1');
	return Buffer.concat([prefix, huffCompress(body)]);
}

export interface OOBMessage {
	/** First token of the first line, e.g. "challengeResponse". */
	command: string;
	/** Tokens of the first line after the command. */
	args: string[];
	/** The whole first line. */
	line: string;
	/** Everything after the first newline (payload of print/infoResponse/statusResponse). */
	data: string;
}

export function decodeOOB(buf: Buffer): OOBMessage | null {
	if (!isOOB(buf)) return null;
	const text = buf.toString('latin1', 4);
	const nl = text.indexOf('\n');
	const line = (nl < 0 ? text : text.slice(0, nl)).replace(/\0.*$/s, '');
	const data = nl < 0 ? '' : text.slice(nl + 1);
	const [command = '', ...args] = tokenize(line);
	return { command, args, line, data };
}
