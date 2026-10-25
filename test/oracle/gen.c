/*
 * Generates test/fixtures/oracle.json from the original engine sources.
 *   cd test/oracle && ./gen.sh
 */
#include "q_shared.h"
#include "qcommon.h"

cvar_t *cl_shownet = NULL;
void QDECL Com_Error( int code, const char *fmt, ... ) { fprintf( stderr, "Com_Error: %s\n", fmt ); exit( 1 ); }
void QDECL Com_Printf( const char *fmt, ... ) {}
void Com_Memset( void *d, const int v, const size_t c ) { memset( d, v, c ); }
void Com_Memcpy( void *d, const void *s, const size_t c ) { memcpy( d, s, c ); }
short LittleShort( short l ) { return l; }
int LittleLong( int l ) { return l; }
void Q_strncpyz( char *dest, const char *src, int destsize ) { strncpy( dest, src, destsize - 1 ); dest[destsize - 1] = 0; }

unsigned int Com_BlockChecksumKey( void *buffer, int length, int key );

static void hex( const byte *d, int n ) {
	int i;
	printf( "\"" );
	for ( i = 0; i < n; i++ ) printf( "%02x", d[i] );
	printf( "\"" );
}

/* verbatim from client/cl_net_chan.c, with clc replaced by arguments */
static void encode( msg_t *msg, int challenge, const char *cmd ) {
	int serverId, messageAcknowledge, reliableAcknowledge;
	int i, index, srdc, sbit, soob;
	byte key, *string;

	srdc = msg->readcount; sbit = msg->bit; soob = msg->oob;
	msg->bit = 0; msg->readcount = 0; msg->oob = 0;
	serverId = MSG_ReadLong( msg );
	messageAcknowledge = MSG_ReadLong( msg );
	reliableAcknowledge = MSG_ReadLong( msg );
	msg->oob = soob; msg->bit = sbit; msg->readcount = srdc;

	string = (byte *)cmd;
	index = 0;
	key = challenge ^ serverId ^ messageAcknowledge;
	for ( i = 12; i < msg->cursize; i++ ) {
		if ( !string[index] ) index = 0;
		if ( string[index] > 127 || string[index] == '%' ) key ^= '.' << ( i & 1 );
		else key ^= string[index] << ( i & 1 );
		index++;
		*( msg->data + i ) = ( *( msg->data + i ) ) ^ key;
	}
}

int main( void ) {
	byte buf[MAX_MSGLEN];
	msg_t m;
	int i;

	printf( "{\n" );

	/* 1. bit writer */
	MSG_Init( &m, buf, sizeof( buf ) );
	MSG_WriteLong( &m, 0x12345678 );
	MSG_WriteBits( &m, 5, 3 );
	MSG_WriteByte( &m, 255 );
	MSG_WriteBits( &m, -300, -16 );
	MSG_WriteBits( &m, 1, 1 );
	MSG_WriteBits( &m, 1000, 10 );
	MSG_WriteString( &m, "say \"hello %world\"" );
	MSG_WriteLong( &m, -1 );
	printf( "  \"bits\": { \"cursize\": %d, \"hex\": ", m.cursize ); hex( buf, m.cursize ); printf( " },\n" );

	/* 2. connect packet */
	{
		const char *info = "\"\\name\\Bot\\protocol\\84\\qport\\123\\challenge\\956240540\"";
		byte pkt[2048];
		msg_t o;
		int len = strlen( info );
		memset( pkt, 0xff, 4 );
		memcpy( pkt + 4, "connect ", 8 );
		memcpy( pkt + 12, info, len );
		MSG_InitOOB( &o, pkt, sizeof( pkt ) );
		o.cursize = 12 + len;
		Huff_Compress( &o, 12 );
		printf( "  \"connect\": { \"hex\": " );
		hex( pkt, o.cursize );
		printf( " },\n" );
	}

	/* 3. client message obfuscation */
	{
		const char *cmd = "print \"hi %there\"";
		MSG_Init( &m, buf, sizeof( buf ) );
		MSG_WriteLong( &m, 1234567 );
		MSG_WriteLong( &m, 42 );
		MSG_WriteLong( &m, 7 );
		MSG_WriteByte( &m, 4 );
		MSG_WriteLong( &m, 9 );
		MSG_WriteString( &m, "say \"a lot of text to be obfuscated\"" );
		MSG_WriteByte( &m, 5 );
		printf( "  \"encode\": { \"challenge\": 956240540, \"command\": \"print \\\"hi %%there\\\"\", \"plain\": " );
		hex( buf, m.cursize );
		encode( &m, 956240540, cmd );
		printf( ", \"encoded\": " );
		hex( buf, m.cursize );
		printf( " },\n" );
	}

	/* 4. block checksum */
	{
		int words[5] = { 0x11111111, (int)0xdeadbeef, 0, 42, -7 };
		printf( "  \"checksum\": [" );
		for ( i = 0; i <= 5; i++ ) {
			printf( "%s{ \"n\": %d, \"key\": -559038737, \"value\": %d }", i ? ", " : "", i, (int)Com_BlockChecksumKey( words, 4 * i, (int)0xdeadbeef ) );
		}
		printf( "]\n" );
	}

	printf( "}\n" );
	return 0;
}
