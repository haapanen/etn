// Bitstream message IO (qcommon/msg.c). Only the non-OOB, Huffman-coded mode is implemented;
// the OOB framing lives in netchan.ts and oob.ts.
import { getMsgHuffman } from './huffman.js';

export const MAX_MSGLEN = 32768;
export const MAX_STRING_CHARS = 1024;
export const BIG_INFO_STRING = 8192;

export class MsgWriter {
	readonly data: Uint8Array;
	bit = 0;
	cursize = 0;
	overflowed = false;

	constructor(private readonly maxsize = MAX_MSGLEN) {
		this.data = new Uint8Array(maxsize + 8);
	}

	private putBit(b: number): void {
		this.data[this.bit >> 3] |= b << (this.bit & 7);
		this.bit++;
	}

	writeBits(value: number, bits: number): void {
		if (this.maxsize - this.cursize < 32) {
			this.overflowed = true;
			return;
		}
		if (bits === 0 || bits < -31 || bits > 32) throw new RangeError(`bad bits ${bits}`);
		if (bits < 0) bits = -bits;

		value = value & (0xffffffff >>> (32 - bits));
		if (bits & 7) {
			const nbits = bits & 7;
			for (let i = 0; i < nbits; i++) {
				this.putBit(value & 1);
				value >>= 1;
			}
			bits -= nbits;
		}
		if (bits) {
			const { codes } = getMsgHuffman();
			for (let i = 0; i < bits; i += 8) {
				for (const b of codes[value & 0xff]) this.putBit(b);
				value >>= 8;
			}
		}
		this.cursize = (this.bit >> 3) + 1;
	}

	writeByte(c: number): void {
		this.writeBits(c, 8);
	}

	writeShort(c: number): void {
		this.writeBits(c, 16);
	}

	writeLong(c: number): void {
		this.writeBits(c, 32);
	}

	writeData(buf: ArrayLike<number>): void {
		for (let i = 0; i < buf.length; i++) this.writeByte(buf[i]);
	}

	/** MSG_WriteString: bytes above 127 are sent as '.', over-long strings as empty. */
	writeString(s: string): void {
		if (s.length >= MAX_STRING_CHARS) s = '';
		for (let i = 0; i < s.length; i++) {
			const c = s.charCodeAt(i);
			this.writeByte(c > 127 ? 0x2e : c);
		}
		this.writeByte(0);
	}

	toBuffer(): Buffer {
		return Buffer.from(this.data.buffer, this.data.byteOffset, this.cursize);
	}
}

export class MsgReader {
	readonly cursize: number;

	constructor(
		readonly data: Uint8Array,
		/** Start position in bits (32 skips the netchan sequence number). */
		public bit = 0,
	) {
		this.cursize = data.length;
	}

	/** True once a read has gone past the end (readcount > cursize in C). */
	get overflowed(): boolean {
		return (this.bit >> 3) + 1 > this.cursize;
	}

	private getBit(): number {
		const t = ((this.data[this.bit >> 3] ?? 0) >> (this.bit & 7)) & 1;
		this.bit++;
		return t;
	}

	readBits(bits: number): number {
		const sgn = bits < 0;
		if (sgn) bits = -bits;
		let value = 0;
		let nbits = 0;
		if (bits & 7) {
			nbits = bits & 7;
			for (let i = 0; i < nbits; i++) value |= this.getBit() << i;
			bits -= nbits;
		}
		if (bits) {
			const { tree } = getMsgHuffman();
			const next = () => this.getBit();
			for (let i = 0; i < bits; i += 8) {
				value |= (tree.decodeSymbol(next) & 0xff) << (i + nbits);
			}
		}
		if (sgn && value & (1 << (bits - 1))) value |= -1 ^ ((1 << bits) - 1);
		return value | 0;
	}

	/** Returns -1 on overflow, like MSG_ReadByte. */
	readByte(): number {
		const c = this.readBits(8) & 0xff;
		return this.overflowed ? -1 : c;
	}

	readShort(): number {
		const c = (this.readBits(16) << 16) >> 16;
		return this.overflowed ? -1 : c;
	}

	readLong(): number {
		const c = this.readBits(32);
		return this.overflowed ? -1 : c;
	}

	/** MSG_ReadString: '%' and bytes above 127 become '.'. */
	readString(): string {
		return this.readStr(MAX_STRING_CHARS, true);
	}

	/** MSG_ReadBigString: only '%' is replaced. */
	readBigString(): string {
		return this.readStr(BIG_INFO_STRING, false);
	}

	private readStr(max: number, ascii: boolean): string {
		let s = '';
		while (s.length < max - 1) {
			let c = this.readByte();
			if (c === -1 || c === 0) break;
			if (c === 0x25 || (ascii && c > 127)) c = 0x2e;
			s += String.fromCharCode(c);
		}
		return s;
	}
}
