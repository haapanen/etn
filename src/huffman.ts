// Port of qcommon/huffman.c (adaptive Huffman) and the static message tree built in qcommon/msg.c.

const NYT = 256;
const INTERNAL_NODE = 257;

interface Slot {
	node: HNode | null;
}

class HNode {
	left: HNode | null = null;
	right: HNode | null = null;
	parent: HNode | null = null;
	next: HNode | null = null;
	prev: HNode | null = null;
	head: Slot | null = null;
	weight = 0;
	symbol = 0;
}

export class HuffTree {
	root: HNode;
	private lhead: HNode;
	private loc: (HNode | null)[] = new Array<HNode | null>(NYT + 1).fill(null);
	private freelist: Slot[] = [];

	constructor() {
		const n = new HNode();
		n.symbol = NYT;
		this.root = this.lhead = n;
		this.loc[NYT] = n;
	}

	private getSlot(): Slot {
		return this.freelist.pop() ?? { node: null };
	}

	private freeSlot(s: Slot): void {
		s.node = null;
		this.freelist.push(s);
	}

	private swap(node1: HNode, node2: HNode): void {
		const par1 = node1.parent;
		const par2 = node2.parent;

		if (par1) {
			if (par1.left === node1) par1.left = node2;
			else par1.right = node2;
		} else {
			this.root = node2;
		}

		if (par2) {
			if (par2.left === node2) par2.left = node1;
			else par2.right = node1;
		} else {
			this.root = node1;
		}

		node1.parent = par2;
		node2.parent = par1;
	}

	private swaplist(node1: HNode, node2: HNode): void {
		let par1 = node1.next;
		node1.next = node2.next;
		node2.next = par1;

		par1 = node1.prev;
		node1.prev = node2.prev;
		node2.prev = par1;

		if (node1.next === node1) node1.next = node2;
		if (node2.next === node2) node2.next = node1;
		if (node1.next) node1.next.prev = node1;
		if (node2.next) node2.next.prev = node2;
		if (node1.prev) node1.prev.next = node1;
		if (node2.prev) node2.prev.next = node2;
	}

	private increment(node: HNode | null): void {
		if (!node) return;

		if (node.next !== null && node.next.weight === node.weight) {
			const lnode = node.head!.node!;
			if (lnode !== node.parent) this.swap(lnode, node);
			this.swaplist(lnode, node);
		}
		if (node.prev && node.prev.weight === node.weight) {
			node.head!.node = node.prev;
		} else {
			node.head!.node = null;
			this.freeSlot(node.head!);
		}
		node.weight++;
		if (node.next && node.next.weight === node.weight) {
			node.head = node.next.head;
		} else {
			node.head = this.getSlot();
			node.head.node = node;
		}
		if (node.parent) {
			this.increment(node.parent);
			if (node.prev === node.parent) {
				this.swaplist(node, node.parent);
				if (node.head!.node === node) node.head!.node = node.parent;
			}
		}
	}

	addRef(ch: number): void {
		const known = this.loc[ch];
		if (known) {
			this.increment(known);
			return;
		}
		const lhead = this.lhead;
		const tnode = new HNode();
		const tnode2 = new HNode();

		tnode2.symbol = INTERNAL_NODE;
		tnode2.weight = 1;
		tnode2.next = lhead.next;
		if (lhead.next) {
			lhead.next.prev = tnode2;
			if (lhead.next.weight === 1) {
				tnode2.head = lhead.next.head;
			} else {
				tnode2.head = this.getSlot();
				tnode2.head.node = tnode2;
			}
		} else {
			tnode2.head = this.getSlot();
			tnode2.head.node = tnode2;
		}
		lhead.next = tnode2;
		tnode2.prev = lhead;

		tnode.symbol = ch;
		tnode.weight = 1;
		tnode.next = lhead.next;
		lhead.next.prev = tnode;
		if (lhead.next.weight === 1) {
			tnode.head = lhead.next.head;
		} else {
			tnode.head = this.getSlot();
			tnode.head.node = tnode2;
		}
		lhead.next = tnode;
		tnode.prev = lhead;
		tnode.left = tnode.right = null;

		if (lhead.parent) {
			if (lhead.parent.left === lhead) lhead.parent.left = tnode2;
			else lhead.parent.right = tnode2;
		} else {
			this.root = tnode2;
		}

		tnode2.right = tnode;
		tnode2.left = lhead;
		tnode2.parent = lhead.parent;
		lhead.parent = tnode.parent = tnode2;

		this.loc[ch] = tnode;
		this.increment(tnode2.parent);
	}

	/** Bits (root to leaf) of the prefix code for a symbol; NYT code if the symbol is unseen. */
	codeBits(ch: number): number[] {
		const bits: number[] = [];
		let node: HNode | null = this.loc[ch];
		if (!node) return this.codeBits(NYT);
		while (node.parent) {
			bits.push(node.parent.right === node ? 1 : 0);
			node = node.parent;
		}
		return bits.reverse();
	}

	has(ch: number): boolean {
		return this.loc[ch] !== null;
	}

	decodeSymbol(nextBit: () => number): number {
		let node: HNode | null = this.root;
		while (node && node.symbol === INTERNAL_NODE) {
			node = nextBit() ? node.right : node.left;
		}
		return node ? node.symbol : 0;
	}
}

// Symbol frequencies used to seed the static tree for message bitstreams (msg_hData in msg.c).
const MSG_HDATA = [
	250315, 41193, 6292, 7106, 3730, 3750, 6110, 23283, 33317, 6950, 7838, 9714, 9257, 17259, 3949, 1778,
	8288, 1604, 1590, 1663, 1100, 1213, 1238, 1134, 1749, 1059, 1246, 1149, 1273, 4486, 2805, 3472,
	21819, 1159, 1670, 1066, 1043, 1012, 1053, 1070, 1726, 888, 1180, 850, 960, 780, 1752, 3296,
	10630, 4514, 5881, 2685, 4650, 3837, 2093, 1867, 2584, 1949, 1972, 940, 1134, 1788, 1670, 1206,
	5719, 6128, 7222, 6654, 3710, 3795, 1492, 1524, 2215, 1140, 1355, 971, 2180, 1248, 1328, 1195,
	1770, 1078, 1264, 1266, 1168, 965, 1155, 1186, 1347, 1228, 1529, 1600, 2617, 2048, 2546, 3275,
	2410, 3585, 2504, 2800, 2675, 6146, 3663, 2840, 14253, 3164, 2221, 1687, 3208, 2739, 3512, 4796,
	4091, 3515, 5288, 4016, 7937, 6031, 5360, 3924, 4892, 3743, 4566, 4807, 5852, 6400, 6225, 8291,
	23243, 7838, 7073, 8935, 5437, 4483, 3641, 5256, 5312, 5328, 5370, 3492, 2458, 1694, 1821, 2121,
	1916, 1149, 1516, 1367, 1236, 1029, 1258, 1104, 1245, 1006, 1149, 1025, 1241, 952, 1287, 997,
	1713, 1009, 1187, 879, 1099, 929, 1078, 951, 1656, 930, 1153, 1030, 1262, 1062, 1214, 1060,
	1621, 930, 1106, 912, 1034, 892, 1158, 990, 1175, 850, 1121, 903, 1087, 920, 1144, 1056,
	3462, 2240, 4397, 12136, 7758, 1345, 1307, 3278, 1950, 886, 1023, 1112, 1077, 1042, 1061, 1071,
	1484, 1001, 1096, 915, 1052, 995, 1070, 876, 1111, 851, 1059, 805, 1112, 923, 1103, 817,
	1899, 1872, 976, 841, 1127, 956, 1159, 950, 7791, 954, 1289, 933, 1127, 3207, 1020, 927,
	1355, 768, 1040, 745, 952, 805, 1073, 740, 1013, 805, 1008, 796, 996, 1057, 11457, 13504,
];

export interface MsgHuffman {
	/** Prefix codes (root to leaf bit sequences) per byte value. */
	codes: number[][];
	tree: HuffTree;
}

let msgHuff: MsgHuffman | null = null;

export function getMsgHuffman(): MsgHuffman {
	if (msgHuff) return msgHuff;
	const tree = new HuffTree();
	for (let i = 0; i < 256; i++) {
		for (let j = 0; j < MSG_HDATA[i]; j++) tree.addRef(i);
	}
	const codes: number[][] = [];
	for (let i = 0; i < 256; i++) codes.push(tree.codeBits(i));
	msgHuff = { codes, tree };
	return msgHuff;
}

/** Huff_Compress for the "connect" OOB packet: adaptive tree, 16-bit big-endian length prefix. */
export function huffCompress(data: Uint8Array): Buffer {
	const size = data.length;
	const out = Buffer.alloc(size * 4 + 16);
	const huff = new HuffTree();
	out[0] = size >> 8;
	out[1] = size & 0xff;
	let bloc = 16;
	const addBit = (bit: number) => {
		const y = bloc >> 3;
		const x = bloc++ & 7;
		out[y] |= bit << x;
	};
	for (let i = 0; i < size; i++) {
		const ch = data[i];
		if (!huff.has(ch)) {
			for (const b of huff.codeBits(NYT)) addBit(b);
			for (let k = 7; k >= 0; k--) addBit((ch >> k) & 1);
		} else {
			for (const b of huff.codeBits(ch)) addBit(b);
		}
		huff.addRef(ch);
	}
	bloc += 8;
	return out.subarray(0, bloc >> 3);
}

/** Huff_Decompress counterpart of huffCompress. */
export function huffDecompress(buf: Uint8Array): Buffer {
	const size = buf.length;
	if (size < 2) return Buffer.alloc(0);
	const huff = new HuffTree();
	const cch = buf[0] * 256 + buf[1];
	let bloc = 16;
	const getBit = () => {
		const t = ((buf[bloc >> 3] ?? 0) >> (bloc & 7)) & 1;
		bloc++;
		return t;
	};
	const out = Buffer.alloc(cch);
	for (let j = 0; j < cch; j++) {
		if (bloc >> 3 > size) break;
		let ch = huff.decodeSymbol(getBit);
		if (ch === NYT) {
			ch = 0;
			for (let i = 0; i < 8; i++) ch = (ch << 1) + getBit();
		}
		out[j] = ch;
		huff.addRef(ch);
	}
	return out;
}
