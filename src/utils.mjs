
import { image_server } from "../config.js"
import { rheos,rheos_groups,rheos_zones,rheos_outputs,services,all_groups,fixed_groups} from "../app.mjs"
import { TIMEOUT } from "../config.js"
import {LOG} from "../config.js"
import { EventEmitter } from "node:events"
export const group_ready = new EventEmitter
export const zone_ready = new EventEmitter

export function get_elapsed_time(start_time) {
	const end_time = new Date();
	let time_diff = end_time.getTime() - start_time.getTime();
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
	const chars = {
		"-" : "\u200B",
		"0" : "\u200C",
		"1" : "\u200D"
	}
	typeof(n)== "number"? n = n.toString(2) : n = parseInt(n.slice(0,n.toString().substring(1).search(/[\D]/)+1),10).toString(2)
	return (n.replace(/[-01]/g, (m)=> chars[m]))
}
export function unhide_value(n){

	const chars = {
		"\u200B":"-",
		"\u200C":"0" ,
		"\u200D":"1"  
	}
	
	n = n.replace(/[\u200B\u200C\u200D]/g, (m)=> chars[m])
 
	return (n = parseInt(n,2) || 0)

}
"® ♫ ░ ▓ 🎼"