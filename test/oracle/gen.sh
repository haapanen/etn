#!/bin/sh
# Rebuilds test/fixtures/oracle.json by compiling the reference engine code.
set -e
cd "$(dirname "$0")"
S=../../Enemy-Territory/src
mkdir -p ../fixtures
# md4.c assumes a 32-bit `long`
sed 's/typedef unsigned long int UINT4;/typedef unsigned int UINT4;/' $S/qcommon/md4.c > /tmp/etn-md4.c
gcc -w -fcommon -I$S/game -I$S/qcommon -o /tmp/etn-oracle gen.c $S/qcommon/msg.c $S/qcommon/huffman.c /tmp/etn-md4.c
/tmp/etn-oracle > ../fixtures/oracle.json
