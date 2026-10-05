import { isIP } from 'node:net';
import { execFileSync } from 'node:child_process';
import { writeFileSync, renameSync } from 'node:fs';

/** Bind container-to-host TLS only on Docker's locally assigned default bridge. */
function assignedInterfaces() {
	// Node omits no-carrier bridges even though Linux keeps their routable address.
	const links = JSON.parse(execFileSync('/usr/sbin/ip',['-json','address','show'],{encoding:'utf8',timeout:10_000,maxBuffer:262144}));
	return Object.fromEntries(links.map((link: {ifname:string;flags:string[];addr_info:Array<{local:string}>}) => [link.ifname,link.addr_info.map(item=>({address:item.local,internal:link.flags.includes('LOOPBACK')}))]));
}
export function edgeBridgeAddress(network: unknown, interfaces: Record<string,Array<{address:string;internal:boolean}>> = assignedInterfaces()) {
	const value = network as { Driver?: string; Options?: Record<string,string>; IPAM?: {Config?: Array<{Gateway?:string}>} };
	if (value.Driver !== 'bridge' || value.Options?.['com.docker.network.bridge.default_bridge'] !== 'true') throw new Error('The managed edge requires the Docker default bridge.');
	const device = value.Options?.['com.docker.network.bridge.name'];
	const address = value.IPAM?.Config?.map(item => item.Gateway).find(item => item && isIP(item) === 4);
	if (!device || !address || !/^(?:10\.|192\.168\.|172\.(?:1[6-9]|2[0-9]|3[01])\.)/u.test(address)
		|| !interfaces[device]?.some(item => item.address === address && !item.internal)) throw new Error('Docker bridge TLS address must be locally assigned private IPv4.');
	return address;
}

export function writeEdgeHostNetwork(path: string, network: unknown) {
	const address = edgeBridgeAddress(network), temporary = `${path}.new`;
	writeFileSync(temporary, JSON.stringify({services:{caddy:{ports:[`${address}:443:443`]}}}), {mode:0o640});
	renameSync(temporary,path);
}
