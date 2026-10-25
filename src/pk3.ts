// Pure-server checksums (qcommon/md4.c + FS_LoadZipFile): needed to pass the server's `cp` verification.
import { closeSync, fstatSync, openSync, readSync } from 'node:fs';

function rol(x: number, n: number): number {
	return (x << n) | (x >>> (32 - n));
}

/** MD4 digest (RFC 1320); Node's crypto often lacks md4 under OpenSSL 3. */
export function md4(input: Uint8Array): Buffer {
	const len = input.length;
	const padLen = len % 64 < 56 ? 56 - (len % 64) : 120 - (len % 64);
	const msg = Buffer.alloc(len + padLen + 8);
	msg.set(input, 0);
	msg[len] = 0x80;
	msg.writeUInt32LE((len << 3) >>> 0, len + padLen);
	msg.writeUInt32LE(Math.floor(len / 0x20000000) >>> 0, len + padLen + 4);

	let a0 = 0x67452301;
	let b0 = 0xefcdab89 | 0;
	let c0 = 0x98badcfe | 0;
	let d0 = 0x10325476;
	const x = new Int32Array(16);

	for (let off = 0; off < msg.length; off += 64) {
		for (let i = 0; i < 16; i++) x[i] = msg.readInt32LE(off + i * 4);
		let a = a0;
		let b = b0;
		let c = c0;
		let d = d0;

		const F = (p: number, q: number, r: number) => (p & q) | (~p & r);
		const G = (p: number, q: number, r: number) => (p & q) | (p & r) | (q & r);
		const H = (p: number, q: number, r: number) => p ^ q ^ r;

		for (const i of [0, 4, 8, 12]) {
			a = rol((a + F(b, c, d) + x[i]) | 0, 3);
			d = rol((d + F(a, b, c) + x[i + 1]) | 0, 7);
			c = rol((c + F(d, a, b) + x[i + 2]) | 0, 11);
			b = rol((b + F(c, d, a) + x[i + 3]) | 0, 19);
		}
		for (const i of [0, 1, 2, 3]) {
			a = rol((a + G(b, c, d) + x[i] + 0x5a827999) | 0, 3);
			d = rol((d + G(a, b, c) + x[i + 4] + 0x5a827999) | 0, 5);
			c = rol((c + G(d, a, b) + x[i + 8] + 0x5a827999) | 0, 9);
			b = rol((b + G(c, d, a) + x[i + 12] + 0x5a827999) | 0, 13);
		}
		for (const i of [0, 2, 1, 3]) {
			a = rol((a + H(b, c, d) + x[i] + 0x6ed9eba1) | 0, 3);
			d = rol((d + H(a, b, c) + x[i + 8] + 0x6ed9eba1) | 0, 9);
			c = rol((c + H(d, a, b) + x[i + 4] + 0x6ed9eba1) | 0, 11);
			b = rol((b + H(c, d, a) + x[i + 12] + 0x6ed9eba1) | 0, 15);
		}
		a0 = (a0 + a) | 0;
		b0 = (b0 + b) | 0;
		c0 = (c0 + c) | 0;
		d0 = (d0 + d) | 0;
	}
	const out = Buffer.alloc(16);
	out.writeInt32LE(a0, 0);
	out.writeInt32LE(b0, 4);
	out.writeInt32LE(c0, 8);
	out.writeInt32LE(d0, 12);
	return out;
}

/** Com_BlockChecksumKey over little-endian int32 words. */
export function blockChecksumKey(words: readonly number[], key: number): number {
	const buf = Buffer.alloc(4 + words.length * 4);
	buf.writeInt32LE(key | 0, 0);
	words.forEach((w, i) => buf.writeInt32LE(w | 0, 4 + i * 4));
	const d = md4(buf);
	return d.readInt32LE(0) ^ d.readInt32LE(4) ^ d.readInt32LE(8) ^ d.readInt32LE(12);
}

export interface PakInfo {
	path: string;
	/** CRC32 of every non-empty entry, in central directory order. */
	crcs: number[];
	names: string[];
}

function readAt(fd: number, length: number, position: number): Buffer {
	const buf = Buffer.alloc(length);
	let got = 0;
	while (got < length) {
		const n = readSync(fd, buf, got, length - got, position + got);
		if (n === 0) throw new Error('unexpected end of file');
		got += n;
	}
	return buf;
}

/** Reads only the zip central directory, so large paks (pak0) stay cheap. */
export function readPak(path: string): PakInfo {
	const fd = openSync(path, 'r');
	try {
		const fileSize = fstatSync(fd).size;
		const tailLen = Math.min(fileSize, 22 + 0xffff);
		const tail = readAt(fd, tailLen, fileSize - tailLen);
		let eocd = -1;
		for (let i = tail.length - 22; i >= 0; i--) {
			if (tail.readUInt32LE(i) === 0x06054b50) {
				eocd = i;
				break;
			}
		}
		if (eocd < 0) throw new Error(`${path}: not a zip file`);
		const count = tail.readUInt16LE(eocd + 10);
		const dirSize = tail.readUInt32LE(eocd + 12);
		const dirOffset = tail.readUInt32LE(eocd + 16);
		const buf = readAt(fd, dirSize, dirOffset);
		let p = 0;
		const crcs: number[] = [];
		const names: string[] = [];
		for (let i = 0; i < count; i++) {
			if (buf.readUInt32LE(p) !== 0x02014b50) throw new Error(`${path}: bad central directory`);
			const crc = buf.readInt32LE(p + 16);
			const size = buf.readUInt32LE(p + 24);
			const nameLen = buf.readUInt16LE(p + 28);
			const extraLen = buf.readUInt16LE(p + 30);
			const commentLen = buf.readUInt16LE(p + 32);
			names.push(buf.toString('latin1', p + 46, p + 46 + nameLen));
			if (size > 0) crcs.push(crc);
			p += 46 + nameLen + extraLen + commentLen;
		}
		return { path, crcs, names };
	} finally {
		closeSync(fd);
	}
}

export const pakPureChecksum = (pak: PakInfo, checksumFeed: number): number => blockChecksumKey(pak.crcs, checksumFeed);

export interface PureCommandInput {
	paks: PakInfo[];
	serverId: number;
	checksumFeed: number;
}

/**
 * Builds the `cp` client command (cl_main.c CL_SendPureChecksums):
 * `cp <serverId> <cgamePak> <uiPak> @ <referenced paks...> <feed ^ refs ^ count>`.
 */
export function buildPureCommand({ paks, serverId, checksumFeed }: PureCommandInput): string {
	const feed = checksumFeed | 0;
	const holder = (re: RegExp) => paks.find((p) => p.names.some((n) => re.test(n))) ?? paks[0];
	const cgame = pakPureChecksum(holder(/(^|\/)cgame[._]mp[._](x86|i386)/i), feed);
	const ui = pakPureChecksum(holder(/(^|\/)ui[._]mp[._](x86|i386)/i), feed);
	const refs = [...new Set(paks.map((p) => pakPureChecksum(p, feed)))];
	let encoded = feed;
	for (const r of refs) encoded ^= r;
	encoded ^= refs.length;
	return `cp ${serverId} ${cgame} ${ui} @ ${refs.join(' ')} ${encoded | 0}`;
}
