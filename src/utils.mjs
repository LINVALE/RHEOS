
import { image_server } from "../config.js"
import { rheos,rheos_groups,rheos_zones,rheos_outputs,services,all_groups,fixed_groups} from "../app.mjs"
import { TIMEOUT,STARTTIME,LOG } from "../config.js"
import { EventEmitter } from "node:events"
import {heos_players} from "../config.js"
import os from "node:os"
import fs from "node:fs/promises"
export const app = await (choose_binary()).catch(err => console.error(get_date(),"Failed to find binary",err))	
export const group_ready = new EventEmitter
export const zone_ready = new EventEmitter
export async function update_status(message = "",warning = false){
	let RheosStatus = heos_players.size + " HEOS Players on " + rheos.system_info[2] +" "+ rheos.system_info [3]+" "+ rheos.system_info [4] + ' at ' + rheos.system_info[0] + '  for ' + get_elapsed_time(STARTTIME) + '\n'
	for (const zone of [...rheos_zones.values()].filter(zone => (zone?.outputs && zone.outputs[0].source_controls[0].display_name.includes("🔗") && zone.state ==="playing") )) {	
		RheosStatus = RheosStatus + (zone.outputs.length == 1 ?"🎵 ":"🎶  ") + (zone.fixed?.zone?.output || zone.display_name) + "\t ▶ \t" + zone.now_playing?.one_line?.line1 + "\n"
	}
	message && (RheosStatus = RheosStatus + "\n" + message)
	services.svc_status.set_status(RheosStatus,warning)
}
export function sliceStringFromValue(str, value) {
	const index = str.indexOf(value);
	if (index === -1) {
	  return "Value not found in string";
	}
	return str.slice(index);
}
export async function choose_binary(fixed = false) {
	if (os.platform() == 'linux') {
		try {
			if (os.arch() === 'arm'){
				await fs.chmod(fixed ? './UPnP/Bin/squeezelite/squeezelite-armv6hf':'./UPnP/Bin/RHEOS-armv6', 0o555)
				return (fixed ? './UPnP/Bin/squeezelite/squeezelite-armv6hf' :'./UPnP/Bin/RHEOS-armv6')
			} else if (os.arch() === 'arm64'){
				await fs.chmod(fixed ? './UPnP/Bin/squeezelite/squeezelite-arm64':'./UPnP/Bin/RHEOS-arm', 0o555)
				return(fixed ? './UPnP/Bin/squeezelite/squeezelite-armv64':'./UPnP/Bin/RHEOS-arm') 
			} else if (os.arch() === 'x64'){ 
				await fs.chmod(fixed ? '../UPnP/Bin/squeezelite/squeezelite-x86-64':'./UPnP/Bin/squeeze2upnp-linux-x86_64-static', 0o555)
				return(fixed ? '../UPnP/Bin/squeezelite/squeezelite-x86-64':'./UPnP/Bin/squeeze2upnp-linux-x86_64-static')
				//await fs.chmod(fixed ? './UPnP/Bin/squeezelite/squeezelite-x86-64':'./UPnP/Bin/rheos-linux-x86_64-static', 0o555)
				//return(fixed ? './UPnP/Bin/squeezelite/squeezelite-x86-64':'./UPnP/Bin/rheos-linux-x86_64-static')
			} else if (os.arch() === 'ia32'){
				await fs.chmod(fixed ?'./UPnP/Bin/squeezelite/squeezelite-i386':'./UPnP/Bin/RHEOS-x86', 0o555)
				return(fixed ? './UPnP/Bin/squeezelite/squeezelite-i386' :'./UPnP/Bin/RHEOS-x86')
			} else {
				console.error(get_date(),"⚠ UNSUPPORTED ARCHITECTURE  - ABORTING",os)
				process.exit(1)
			}
		} catch {
			console.error(get_date(),"⚠ UNABLE TO LOAD LINUX BINARIES - ABORTING")
		}
	}
	else if (os.platform() == 'win32') {
		return(fixed ? './UPnP/Bin/squeezelite/squeezelite-x64.exe' :'./UPnP/Bin/RHEOS2UPNP.exe')
	} 
	else if (os.platform() == 'darwin') {
		try {
			await fs.chmod(fixed ? "" :'./UPnP/Bin/RHEOS-macos-x86_64-static', 0o555)
			return(fixed ? "" :'./UPnP/Bin/RHEOS-macos-x86_64-static')} 
		catch {
			console.error(get_date(),"⚠ UNABLE TO LOAD MAC BINARIES - ABORTING")
			process.exit(1)
		}
	}
	else {
		console.error(get_date(),"⚠ THIS OPERATING SYSTEM IS NOT SUPPORTED");
		process.exit(1)
	}
}
export function get_elapsed_time(STARTTIME) {
	const end_time = new Date();
	let time_diff = end_time.getTime() - STARTTIME.getTime();
	time_diff = time_diff / 1000;
	const seconds = Math.floor(time_diff % 60)
	time_diff = Math.floor(time_diff / 60)
	const minutes = time_diff % 60
	time_diff = Math.floor(time_diff / 60)
	const hours = time_diff % 24
	time_diff = Math.floor(time_diff / 24)
	const days = time_diff;
	return (days ? days + (days == 1 ? " day " : " days " ) : "") + (hours ? hours + ' hour'+ (hours === 1 ? "  " : "s " ) : "") + minutes + (minutes === 1 ? " minute ":" minutes ") + seconds +(seconds === 1 ? " second " : " seconds ");
}
export function init_signal_handlers() {
	const handle = async function(signal) {
		console.warn("\r<- ",get_date(),"RHEOS: SYSTEM    : RHEOS IS GRACEFULLY SHUTTING DOWN FROM",signal)
		image_server.close()
		try{
			Object.values(rheos.processes).forEach((proc) => {
				if (proc && proc.pid) 	{
					try {
						process.kill(proc.pid,'SIGKILL')
						console.log("-> ",get_date(),"RHEOS: SYSTEM    : SHUTDOWN RHEOS PLAYER",proc?.spawnargs[1] == '-b' ? proc.spawnargs[5] : proc.spawnargs[2] ? proc.spawnargs[2] : proc.spawnargs,proc.pid)
					} catch(err){
						console.warn("-> ",get_date(),"RHEOS: SYSTEM   ⚠ FAILED TO KILL PROCESS",proc.pid,err)
					}
				}
			})
			console.log("-> ",get_date(),"RHEOS: SYSTEM    : SHUTDOWN COMPLETE")
			process.exit(1)	
		} catch{
			console.error("ERROR SHUTTING DOWN")
		}
	};
   process.on('SIGTERM', handle);
	process.on('SIGINT', handle);
	process.on('SIGHUP', handle);
	process.on('uncaughtException', (err) => {
	console.error('Uncaught exception:', err);
	handle()
		
	})

}
export function sum_array(array) {
	if (array == undefined || !Array.isArray(array)) { return 0 }
	let total = array?.reduce(function (acc, cur) { return acc + cur }, typeof (array[0]) == 'string' ? "" : 0)
	return total
}
export function to_title_case(str) {
	return str.replace(
	  /\w\S*/g,
	  function(txt) {
		return txt.charAt(0).toUpperCase() + txt.substr(1).toLowerCase();
	  }
	)
}  
export function suppressExperimentalWarnings (p){
	const originalEmit = p.emit
	p.emit = function (event, warning) {
	  	if (event === 'warning' && warning?.name === 'ExperimentalWarning') {
			return false
	  	}
		return originalEmit.apply(p, arguments);
	}
}
export function validateIPAddressOptimized(ip) {
	const ipv4Regex = /^(\d{1,3}\.){3}\d{1,3}$/;
	const ipv6Regex = /^([\da-f]{1,4}:){7}[\da-f]{1,4}$/i;
	if (ipv4Regex.test(ip)) {
	  return ip.split('.').every(part => parseInt(part) <= 255);
	}
	if (ipv6Regex.test(ip)) {
	  return ip.split(':').every(part => part.length <= 4);
	}
	return false;
}
export function get_date(){
	return (
		new Date().toLocaleString('en-US',{
			month : '2-digit',
			day:'2-digit',
			year : 'numeric',
			hour : '2-digit',
			minute : '2-digit',
			second: '2-digit',
			fractionalSecondDigits : 3
		})
	)
}
export function clean_up(){
	console.log("CLEANING UP ALL PROCESSES",rheos.processes)
 for (const proc of Object.values(rheos.processes))
	if (proc && proc.pid) 	{
		try {
			process.kill(proc.pid,'SIGKILL')
		} catch{
			console.warn("Failed to killl process",proc.pid,err)		}
	}

}
export function hide_value(n){ 
	if (!n) return
	const chars = {
		"-" : "\u200B",
		"0" : "\u200C",
		"1" : "\u200D"
	}
	typeof(n)== "number"? n = n.toString(2) : n = parseInt(n.slice(0,n.toString().substring(1).search(/[\D]/)+1),10).toString(2)
	return (n.replace(/[-01]/g, (m)=> chars[m]))
}
export async function get_zones(){
	return(new Promise((resolve, reject) => {
			services.svc_transport.get_zones((err,res) => (err ? reject(err) : resolve(res)) )	
		})
	)
}
export async function update_zone(zone){

		return(new Promise((resolve, reject) => {
			console.log("UPDATING ZONE",zone)

			services.svc_transport.get_zones((err,res) => {if (err){
				 reject(err)}
				 else {
//console.log(res)
					let z = (res.zones.filter ((z) => z.zone_id == zone.zone_id)[0])
					console.log("ZONE FOUND",z,zone.zone_id)
					z = rheos_zones.get(zone.zone_id)
					if (z){
						z.zone = zone
					}
					//z.zone_id && rheos_zones.set(z.zone_id,z)
					resolve()
//es.zones.filter((z) => {(z?.zone_id || z) == zone.zone_id}
				 }  	
		})
	
}))
}
export   function  get_zone_players(z) {
        if (!z?.outputs) return({players : [], sum_group : 0})
        let group = {players : [], sum_group : 0}
        for (let op of z.outputs){
            if (op?.source_controls[0]?.display_name?.includes ("🔗")){
                continue
            }
            if (op.source_controls[0].display_name.includes("RHEOS")){
                let v = unhide_value(op.source_controls[0].display_name)
                group.players.push(v)
                group.sum_group = group.sum_group + v
            }
        }
        return(group)
    } 

export async function get_zones_group_values(){

	return(new Promise((resolve, reject) => {
			services.svc_transport.get_zones((err,res) => {if (err) {
				reject(err)}
			else {
				let zone_sum_values = []
				for (let z of res.zones){
					
					if(z.display_name.includes("RHEOS") && z.outputs.length >1){
                 		zone_sum_values.push(sum_array(z.outputs.map(o => o.source_controls[0].display_name.includes ("🔗") ? 0 : unhide_value(o.source_controls[0].display_name))))
					}
				}
				resolve(zone_sum_values)
			} 
		})	
	
		}	
	
	))
}


export function unhide_value(n){
  if (!n) return
  if (typeof(n) != "string") {return }	
  const chars = {
		"\u200B":"-",
		"\u200C":"0" ,
		"\u200D":"1"  
	}
	
	n = n.replace(/[\u200B\u200C\u200D]/g, (m)=> chars[m])
 
	return (n = parseInt(n,2) || 0)

}
"® ♫ ░ ▓ 🎼"