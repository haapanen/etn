import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { huffCompress, huffDecompress } from '../src/huffman.js';
import { MsgReader, MsgWriter } from '../src/msg.js';
import { encodeClientMessage, decodeServerMessage, Netchan, FRAGMENT_SIZE } from '../src/netchan.js';
import { encodeConnectPacket, decodeOOB, encodeOOB } from '../src/oob.js';
import { blockChecksumKey, md4 } from '../src/pk3.js';
import { buildInfo, infoValue, parseChat, parseInfo, tokenize } from '../src/text.js';

// Vectors produced by compiling the original engine sources (test/oracle/gen.sh).
const oracle = JSON.parse(readFileSync(new URL('./fixtures/oracle.json', import.meta.url), 'utf8'));

describe('bit messages', () => {
	it('matches MSG_Write* output of the engine', () => {
		const w = new MsgWriter();
		w.writeLong(0x12345678);
		w.writeBits(5, 3);
		w.writeByte(255);
		w.writeBits(-300, -16);
		w.writeBits(1, 1);
		w.writeBits(1000, 10);
		w.writeString('say "hello %world"');
		w.writeLong(-1);
		expect(w.cursize).toBe(oracle.bits.cursize);
		expect(w.toBuffer().toString('hex')).toBe(oracle.bits.hex);
	});

	it('reads back what it wrote', () => {
		const w = new MsgWriter();
		w.writeLong(-123456);
		w.writeBits(5, 3);
		w.writeBits(-300, -16);
		w.writeBits(1000, 10);
		w.writeString('say "hello %world"');
		const r = new MsgReader(w.toBuffer());
		expect(r.readLong()).toBe(-123456);
		expect(r.readBits(3)).toBe(5);
		expect(r.readBits(-16)).toBe(-300);
		expect(r.readBits(10)).toBe(1000);
		expect(r.readString()).toBe('say "hello .world"');
	});
});

describe('connect packet', () => {
	it('matches Huff_Compress of the engine', () => {
		const info = '\\name\\Bot\\protocol\\84\\qport\\123\\challenge\\956240540';
		expect(encodeConnectPacket(info).toString('hex')).toBe(oracle.connect.hex);
	});

	it('round-trips through the adaptive decompressor', () => {
		const data = Buffer.from('"\\name\\x\\protocol\\84"');
		expect(huffDecompress(huffCompress(data)).equals(data)).toBe(true);
	});
});

describe('message obfuscation', () => {
	const commands: string[] = [];
	commands[9 & 255] = 'x';

	it('matches CL_Netchan_Encode of the engine', () => {
		const plain = Buffer.from(oracle.encode.plain, 'hex');
		encodeClientMessage(plain, plain.length, oracle.encode.challenge, withCommand(7, oracle.encode.command.replace('%%', '%')));
		expect(plain.toString('hex')).toBe(oracle.encode.encoded);
	});

	it('decode reverses the server-side transform', () => {
		// Encoding is an XOR stream, so applying decode on [seq][payload] twice restores the payload.
		const w = new MsgWriter();
		w.writeLong(3);
		for (let i = 0; i < 20; i++) w.writeLong(i * 7919);
		const payload = w.toBuffer();
		const msg = Buffer.concat([Buffer.alloc(4), payload]);
		msg.writeInt32LE(5, 0);
		const original = Buffer.from(msg);
		const cmds = withCommand(3, 'cmd text');
		decodeServerMessage(msg, 99, cmds);
		expect(msg.equals(original)).toBe(false);
		decodeServerMessage(msg, 99, cmds);
		expect(msg.equals(original)).toBe(true);
	});
});

function withCommand(seq: number, text: string): string[] {
	const a: string[] = new Array(256).fill('');
	a[seq & 255] = text;
	return a;
}

describe('pure checksums', () => {
	it('md4 matches RFC 1320 vectors', () => {
		expect(md4(Buffer.from('')).toString('hex')).toBe('31d6cfe0d16ae931b73c59d7e0c089c0');
		expect(md4(Buffer.from('abc')).toString('hex')).toBe('a448017aaf21d8525fc10ae87aa6729d');
		expect(md4(Buffer.from('12345678901234567890123456789012345678901234567890123456789012345678901234567890')).toString('hex')).toBe(
			'e33b4ddc9c38f2199c3e7b164fcc0536',
		);
	});

	it('blockChecksumKey matches Com_BlockChecksumKey', () => {
		const words = [0x11111111, 0xdeadbeef | 0, 0, 42, -7];
		for (const { n, key, value } of oracle.checksum) {
			expect(blockChecksumKey(words.slice(0, n), key)).toBe(value);
		}
	});
});

describe('netchan', () => {
	it('fragments large messages and reassembles them', () => {
		const data = Buffer.alloc(FRAGMENT_SIZE * 2 + 10, 7);
		data.writeUInt32LE(0xabcdef01, 0);
		const sender = new Netchan(5);
		const packets = sender.transmit(data);
		expect(packets).toHaveLength(3);

		// a server-side channel has no qport in its packets
		const receiver = new Netchan(0);
		let out: Buffer | null = null;
		for (const p of packets) {
			const noQport = Buffer.concat([p.subarray(0, 4), p.subarray(6)]);
			out = receiver.process(noQport);
		}
		expect(out).not.toBeNull();
		expect(out!.subarray(4).equals(data)).toBe(true);
		expect(out!.readInt32LE(0)).toBe(1);
	});

	it('drops duplicate and old sequence numbers', () => {
		const ch = new Netchan(0);
		const p = Buffer.alloc(8);
		p.writeInt32LE(4, 0);
		expect(ch.process(p)).not.toBeNull();
		expect(ch.process(p)).toBeNull();
		p.writeInt32LE(3, 0);
		expect(ch.process(p)).toBeNull();
	});
});

describe('text helpers', () => {
	it('parses info strings', () => {
		expect(parseInfo('\\a\\1\\b\\two')).toEqual({ a: '1', b: 'two' });
		expect(infoValue('\\Name\\x', 'name')).toBe('x');
		expect(buildInfo({ a: 1, b: 'x' })).toBe('\\a\\1\\b\\x');
	});

	it('tokenizes like Cmd_TokenizeString', () => {
		expect(tokenize('chat "Bob^7: ^2hi there" 3 0')).toEqual(['chat', 'Bob^7: ^2hi there', '3', '0']);
		expect(tokenize('a // comment')).toEqual(['a']);
	});

	it('parses chat commands', () => {
		expect(parseChat('chat', ['Bob^7: ^2hello ^7world', '3', '0'])).toMatchObject({
			type: 'public',
			team: false,
			sender: 'Bob',
			clientNum: 3,
			message: 'hello ^7world',
		});
		expect(parseChat('tchat', ['[lof](Bob^7) (Garage): ^5push!', '3', '1'])).toMatchObject({
			type: 'team',
			team: true,
			sender: 'Bob',
			location: 'Garage',
			message: 'push!',
		});
		expect(parseChat('tchat', ['[lof](Bob^7) (Garage): ^3stack up', '3', '1'])).toMatchObject({
			type: 'fireteam',
			message: 'stack up',
		});
	});

	it('decodes OOB packets', () => {
		const m = decodeOOB(encodeOOB('print\nhello\n'))!;
		expect(m).toMatchObject({ command: 'print', args: [], data: 'hello\n' });
		expect(decodeOOB(encodeOOB('challengeResponse 123 1'))).toMatchObject({ command: 'challengeResponse', args: ['123', '1'] });
	});
});
