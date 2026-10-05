import {describe,it,expect} from 'vitest';
import {edgeBridgeAddress} from '../src/edge/host-network.js';
const network={Driver:'bridge',Options:{'com.docker.network.bridge.default_bridge':'true','com.docker.network.bridge.name':'docker0'},IPAM:{Config:[{Gateway:'172.17.0.1'}]}};
const interfaces={docker0:[{address:'172.17.0.1',internal:false}]} as any;
describe('container-to-host HTTPS edge',()=>{
	it('accepts only the observed locally assigned Docker default bridge',()=>expect(edgeBridgeAddress(network,interfaces)).toBe('172.17.0.1'));
	it('rejects wildcard, public, loopback, metadata and unassigned addresses',()=>{
		for(const Gateway of ['0.0.0.0','8.8.8.8','127.0.0.1','169.254.169.254','192.168.1.2']) expect(()=>edgeBridgeAddress({...network,IPAM:{Config:[{Gateway}]}},interfaces)).toThrow();
		expect(()=>edgeBridgeAddress({...network,Driver:'host'},interfaces)).toThrow();
		expect(()=>edgeBridgeAddress({...network,Options:{}},interfaces)).toThrow();
	});
});
