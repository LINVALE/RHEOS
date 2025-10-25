const version = "0.12.2"
"use strict"
import RoonApi from "node-roon-api"
import RoonApiSettings from "node-roon-api-settings"
import RoonApiStatus from "node-roon-api-status"
import RoonApiTransport from "node-roon-api-transport"
import RoonApiSourceControl from "node-roon-api-source-control"
import RoonApiVolumeControl from "node-roon-api-volume-control"
import child from "node:child_process"
import fs from "node:fs/promises"
import os from "node:os"
import ip from "ip"
import process,{pid} from "node:process"
import RheosConnect from "telnet-client"
import { error} from "node:console"
import { clearTimeout } from "node:timers"
import {LOG} from "./config.js"
import {TIMEOUT,SHORTTIMEOUT,heos_players} from "./config.js"
import {Heos_group} from "./src/heos_group.mjs"
import {Heos_player} from "./src/heos_player.mjs"
import {Fixed_group} from "./src/fixed_group.mjs"
import {sum_array,choose_binary} from "./src/utils.mjs"
import {heos_command , get_outputs, get_all_groups,set_players,start_heos,monitor_status, group_enqueue, get_group_sum_group,get_zone_group_value} from "./src/heos_utils.mjs"
import {init_signal_handlers,to_title_case,suppressExperimentalWarnings,validateIPAddressOptimized,get_date,hide_value,unhide_value} from "./src/utils.mjs"
import {listeners} from "./src/listeners.mjs"
import { update_status } from "./src/utils.mjs"

export const services = {svc_status:{},svc_transport :{},svc_volume_control :{},svc_settings : {}}
export const rheos_zones = new Map()
export const rheos_outputs = new Map()
export const rheos_groups = new Map()
export const rheos = {processes:{},mode:false, discovery:0,working:false,ready : false, avr:{},has_avr:false,system_info:[ip.address(),os.type(),os.hostname(),os.platform(),os.arch()],myfixed_groups:[],fixed_group_control:{},block_avr_update:false,base_groups : []}
export const fixed_groups = new Map()
export const all_groups = new Map()
export const squeezelite ="squeezelite" 
export const roon = await connect_roon().catch((err)=> {console.error(get_date(),"Failed to connect with ROON server",err)})

const avr_buffer = {}
const exec = child.execSync
const spawn = child.spawn
const avr_zone_controls = {}
const avr_volume_controls = {}
const rheos_connect = RheosConnect.Telnet
const sound_modes = ["MSSTEREO","MSDIRECT","MSPURE DIRECT","MSMCH STEREO"]
suppressExperimentalWarnings(process)
init_signal_handlers()
rheos_zones.groups = new Set()
await start_up().catch((err) => console.error("⚠ ERROR STARTING UP",err))

async function start_up(restarting = false){
	if (restarting){
		console.log ("STATE OF PLAYERS",heos_players)
	}
	console.log("-> ",get_date(),"RHEOS: SYSTEM    :",rheos.system_info.toString(),"Version :",roon.extension_reginfo.display_version, "NODEJS VERSION:",process.version)
	return new Promise (async function (resolve,reject)	{
	try{
		exec("pkill -f -9 UPnP")
        exec("pkill squeezelite")
	} catch{
		console.warn("-> ",get_date(),"RHEOS: WARNING   ⚠ No UPnP/Squeezelite Processes Identified to Kill")
	}
	await start_roon().catch(err => console.error(get_date(),"⚠ Error Starting Roon",err => {throw err(err),reject()}))
	await start_heos().catch((err) => {console.error(get_date(),"⚠ Error Starting Heos",err);reject()})
	rheos.base_groups = await heos_command("group", "get_groups",TIMEOUT,true).catch(err => console.error(get_date(),err))
	let link_outputs = setInterval(async () => {
		await get_outputs(0,true);
		let linked = Array.from(heos_players.values()).filter(p => p.output);
		let activated = [...rheos_outputs.values()].filter (o => o.display_name.includes("RHEOS"))
		LOG && console.log("-> ",get_date(),"RHEOS: LINKED    :",linked.length,"HEOS PLAYERS" )
		LOG && console.log("-> ",get_date(),"RHEOS: ACTIVATED :",activated.length,"HEOS PLAYERS" )
		LOG && console.log("-> ",get_date(),"RHEOS: SERVER    : IP ADDRESS",roon.paired_core?.moo?.transport?.host)
		rheos.base_groups.payload.forEach(o => {
			LOG && console.log("-> ",get_date(),"RHEOS: CREATING   : ROON ZONE",o.name,"FROM BASE HEOS GROUP" )
			if (! rheos_zones.has(o.gid )){
				let g = rheos_zones.set(o.gid,new Heos_group(o)).get(o.gid)
				g.group=(o)
			}
		})
	    if (linked && linked.length >1 && activated.every(o =>  linked.find (p => p.output.output_id == o.output_id))){
				let players = Array.from(heos_players.values(), (o) => o.saved_player_info)
				LOG && console.log("-> ",get_date(),"RHEOS: SAVING    :",activated.length,"ACTIVATED HEOS PLAYERS" )
				players = rheos.myplayers.map((o) => {let {output,timeout,bridge,gid,Z2,PWR,volume,zone,state,status,group,now_playing,awaiting,position,duration,rheos,next,payload,force_play, ...p} = o;return(p)})
				rheos.myplayers = players
				roon.save_config("players",players);
			if (linked.length){
				 await 	listeners().catch(err => console.error(get_date(),"⚠ Error Adding Listeners",err => {console.error(rheos.connection),reject()}))
				clearInterval (link_outputs)
			} else {
				console.warn(" ************* PLEASE ENABLE RHEOS IN SETTINGS -> EXTENSIONS -> RHEOS ******************")
			}
			await create_zone_controls().catch( err => {console.error(get_date(),"⚠ Error Creating Zone Controls",err);reject()})
	
		}
	},SHORTTIMEOUT)
	const c = spawn("squeezelite")
		c.on('error', async function(err) {
	    LOG && console.warn(get_date(),'SQUEEZELITE NOT INSTALLED : LOADING BINARIES');
		squeezelite = await choose_binary("squeezelite",true).catch(err => console.error(get_date(),"⚠ Error Loading Squeezelite Binaries",err => {console.error(err),reject()}))
	})
	c.on('spawn',() => console.log("-> ",get_date(),"RHEOS: SYSTEM    : SQUEEZELITE IS INSTALLED ON OPERAING SYSTEM",os.type()))
    process.kill(c.pid,'SIGTERM')
	console.log("-> ",get_date(),"RHEOS: SYSTEM    :",rheos.system_info.toString(),"Version :",roon.extension_reginfo.display_version, "NODEJS VERSION:",process.version)
	rheos.mysettings.fixed_control && await load_fixed_groups().catch( err => {console.error(get_date(),"⚠ Error Loading Fixed Groups",err);reject()})
	Object.entries(rheos.mysettings).filter(o => o[0][2] && isNaN(o[0][2])).forEach(o => LOG && console.log("-> ",get_date(),"RHEOS: SETTING   :",to_title_case(o[0].padEnd(20 ,".")),o[1] ? (o[1] === true || o[1] === 1) ? "On" : o[1] : o[1]===0 ? "Off" : "Not Defined"))
	await restart_zones()
	await get_outputs(0,true)
	rheos.ready = true
	resolve()
	}).catch( err => {
		console.error(get_date(),"⚠ Error Starting Up")
		process.exit(err)
	})
}
async function restart_zones(){
	[...rheos_zones.values()].filter(z => z.state == "playing").map(z => {
		let timer = setInterval(() => {	
			let zone = services.svc_transport.zone_by_zone_id(z.zone_id)
			LOG && console.log("-> ",get_date(),"RHEOS: ZONE      : RESTART OF ZONE",zone.display_name,"MONITORED",zone.state,zone.is_play_allowed,z.now_playing.seek_position,zone.now_playing.seek_position,z.now_playing?.one_line?.line1 , zone.now_playing?.one_line?.line1 )
			if (zone?.is_play_allowed){
				services.svc_transport.control(zone,'play',(err)=> {
					err || LOG && console.log("-> ",get_date(),"RHEOS: ZONE      : RESTART OF ZONE",zone.display_name,"REQUESTED" )
				})			
			} else if (zone?.state == "playing" && (((zone.now_playing.seek_position - z.now_playing.seek_position) > 4)) || (z.now_playing?.one_line?.line1 !== zone.now_playing?.one_line?.line1)){
				clearInterval(timer) 
			}	
		},2000)
	})
}
async function load_fixed_groups(){
		let controller = {    
		state: {
			display_name: "Show Fixed Group Loading Status",
			supports_standby: false,
			status:  "indeterminate",
		},  
		convenience_switch : async function (req) {
			rheos.block_avr_update = true
			setTimeout( () => {
				req.send_complete("Success")
				rheos.block_avr_update = false
			},3000)
		},  
		standby:  async function (req) {
			LOG && console.log("STANDING BY FIXED GROUP")
			req.send_complete("Success")				 
		}
	}
	Object.keys(rheos.fixed_group_control).length === 0 && (rheos.fixed_group_control = services.svc_source_control.new_device(controller))
	for (const group of rheos.myfixed_groups){
		const fixed = new Fixed_group(group)
		fixed_groups.set (get_group_sum_group(group),fixed)
	}
	return
}
async function unload_fixed_groups(){
	rheos.myfixed_groups.length &&
	rheos.myfixed_groups.forEach( async fg => {
		remove_fixed_group(fg.sum_group,false).catch(()=> {})
	})
	return
}
async function remove_fixed_group(sum_group,remove) {	
	let index = rheos.myfixed_groups.findIndex(g=> sum_group == g.sum_group) 
	if (index > -1 ){
		const output = [...rheos_outputs.values()].find(o => o.source_controls && o.source_controls[0].display_name == rheos.myfixed_groups[index].display_name)
		console.log("->",get_date(),"RHEOS: REMOVING : FIXED GROUP",output?.display_name)
		if (output){
			delete rheos.mysettings[sum_group]
			fixed_groups.delete(sum_group)
			services.svc_transport.ungroup_outputs([output])
			remove && rheos.myfixed_groups.splice(index,1)
			process.kill(Number(rheos.processes[Math.abs(sum_group).toString(16)].pid),'SIGKILL')
			delete rheos.processes[Math.abs(sum_group).toString(16)]
		}   
	} else {
		console.error("-> RHEOS: UNABLE TO FIND FIXED GROUP LOOKING >>>",sum_group)
	}
   	return 
}
async function start_roon(restart) {
	LOG && console.log("-> ",get_date(),"RHEOS: SYSTEM    :",restart ? "RESTARTING":"STARTING","RHEOS")
	clearInterval(rheos.heart_beat)
	const def = JSON.parse(await fs.readFile('./default_settings.json','utf-8'))
	services.svc_status = new RoonApiStatus(roon)
	services.svc_transport = new RoonApiTransport(roon)
	services.svc_source_control = new RoonApiSourceControl(roon)
	services.svc_volume_control = new RoonApiVolumeControl(roon)
	rheos.mysettings = roon.load_config("settings")|| def.settings || {}
	rheos.mysettings.log_limit || (rheos.mysettings.log_limit = 1)
	rheos.myplayers = roon.load_config("players") || []
	rheos.mysettings.clear_settings = 0	
	rheos.mysettings.refresh_players = 0	
	rheos.mysettings.reboot_heos = 0
	roon.start_discovery()
	if (restart){
		monitor_status(1)
	}
	if (rheos.mysettings.fixed_control){
		rheos.myfixed_groups = roon.load_config("fixed_groups") || []
		Array.isArray (rheos.myfixed_groups)  &&   rheos.myfixed_groups?.forEach(group => {
		const fixed = new Fixed_group(group)
		fixed_groups.set(get_group_sum_group(group),fixed)
		})		
	}	
	services.svc_settings = new RoonApiSettings(roon, {
		get_settings: async function (cb) {
			Array.isArray(rheos.myplayers) && rheos.myplayers.forEach(p => {
				if (p && p?.model && !p.resolution){p.resolution =  p.model.includes("HEOS")? "CD": "THRU"}
			 	rheos.mysettings["P"+String(p.pid)] = p.resolution 
				rheos.mysettings["M"+String(p.pid)] = (p.mode || "FLOW")
				rheos.mysettings["A"+String(p.pid)] = (p.auto_play || "OFF")
			})
			//let groups = Array.from(get_all_groups())
			//console.log("GROUPS ARE ",groups)
			//Array.isArray(groups) && groups.forEach(g => {rheos.mysettings[g.sum_group] = (g.resolution || 192000)})
			cb(makelayout(rheos.mysettings))
		},
		save_settings: async function (req, isdryrun, settings) {
			let l = makelayout(settings.values)
			if (!isdryrun && !l.has_error) {
				let need_create = false
				if (settings.values.clear_settings ) {
					try {
						exec("pkill -f -9 UPnP")
						exec("pkill squeezelite")
					} catch {	
						console.error("UNABLE TO KILL ALL PLAYERS")		
					}
					settings.values = def.settings
					rheos.mysettings.clear_settings = 0
					rheos.system_info = [ip.address(), os.type(), os.hostname(), os.platform(), os.arch()]
					await start_heos()
					console.log("-> ",get_date(),"RHEOS: RESET TO DEFAULTS")
					update_status("Settings returned to defaults",true)
				} 
				if (settings.values.refresh_players) {
					try{
						await start_heos()
						console.log("-> ",get_date(),"RHEOS: REFRESHED PLAYERS")
						update_status("Players refreshed",true)
						settings.values.refresh_players = 0	
					}
					catch {console.error("ERROR RESETTING PLAYERS")}
				}
				if (settings.values.reboot_heos) {
					reboot_heos_server()
					console.log("-> ",get_date(),"RHEOS: REBOOTING HEOS SERVER")
					settings.values.reboot_heos = 0	
					process.exit(2)
				}			
				for  (let player of rheos.myplayers){	
					if (player?.model && !player?.resolution){
						player.resolution =player.model.includes("HEOS")? "CD" : "THRU" 
					}
					const options= [["P",player.resolution ,"resolution"],["M","FLOW","mode"]]
					for (let option of options){
						let id = `${option[0]}${player.pid}`
						if(player[option[2]]  && player[option[2]] !== l.values[id]){
							player[option[2]] = (l.values[id] || option[1])
							rheos.mysettings[id] = (l.values[id] || option[1])	
							need_create = true
						}
					}
					if (Array.isArray(player.PWR)){
						if (player.auto_play !== l.values["A"+String(pid)]){
							player.auto_play =  l.values["A"+String(pid)]
							rheos.mysettings[`A${(pid)}`] = player.auto_play
							let p = heos_players.get(player.pid)?.player
							if (p) {p.auto_play = player.auto_play}
						}
					}		
				}
				let players = rheos.myplayers.map((o) => {let {output,timeout,bridge,gid,Z2,PWR,volume,zone,state,status,group,now_playing,awaiting,position,duration,rheos,next,payload,force_play, ...p} = o;return(p)})
			    rheos.myplayers = players	
				for await (const group of get_all_groups()){
					group[1].resolution = settings.values[get_group_sum_group(group[1])] 
					if (settings.values[get_group_sum_group(group[1])] >-1 ){
						const fixed = new Fixed_group(group[1])
						fixed_groups.set (get_group_sum_group(group[1]),fixed)
						rheos.myfixed_groups = Array.from(fixed_groups.values()).map(fg => fg._group)
					} else {	
						remove_fixed_group(group[0],true)
					}
				}
				if (settings?.values?.fixed_control){
					await load_fixed_groups().catch(err => console.error(get_date(),"⚠ Error Loading Fixed Groups",(err) => {throw error(err),reject()}))
				} else {
				  	await unload_fixed_groups().catch(err => console.error(get_date(),"⚠ Error Unloading Fixed Groups",(err) => {throw error(err),reject()}))
				}
				if (settings.values.avr_control){ 
					if (settings.values.avr_control !== rheos.mysettings.avr_control){
						await create_zone_controls().catch( err => {console.error(get_date(),"⚠ Error Creating Zone Controls",err);reject()})
					}
					let avrs = Array.from(heos_players.values(), (o) => o.player).filter(player => player.type == "AVR")
					for (let avr of avrs){
						avr_volume_controls[avr.pid]?.update_state({	state: {
							volume_type:  "number"
					}})
					await update_avr_status()
					}
					
				} else {
					for (let o of Object.entries(avr_zone_controls)){
						let zone = services.svc_transport.zone_by_output_id(o[1]?.output?.output_id)	
						if (zone?.outputs){
							services.svc_transport.ungroup_outputs(zone.outputs)
						}
						if (avr_zone_controls[o[0]]){
							o[1].update_state({supports_standby : false, status : 'deselected'})
							await kill_avr_output(Number(o[0]))
						} 	
					}		
				} 
				const select= ({
					default_player_ip,host_ip,streambuf_size,output_size,stream_length,seek_after_pause,volume_on_play,volume_feedback,accept_nexturi,flac_header,keep_alive,next_delay,max_safe_vol,avr_control,fixed_control,log_limit,log,clear_settings,refresh_players,cache
			    }) => ({
					default_player_ip,host_ip,streambuf_size,output_size,stream_length,seek_after_pause,volume_on_play,volume_feedback,accept_nexturi,flac_header,keep_alive,next_delay,max_safe_vol,avr_control,fixed_control,log_limit,log,clear_settings,refresh_players,cache
				})
				const selected = select(rheos.mysettings)
				const changed = select(settings.values)
				if (JSON.stringify(Object.values(selected)) !== JSON.stringify(Object.values(changed))){
					console.log("-> ",get_date(),"RHEOS: SETTINGS  : CHANGES DETECTED")
					update_status("UPDATING UPnP SETTINGS - PLEASE WAIT",false)
					roon.save_config("settings", changed)
					rheos.mysettings = changed
					//LOG = changed.log
					try{
						exec("pkill -f -9 UPnP")
						exec("pkill squeezelite")
					} catch{}
					set_players(rheos.myplayers)
	                let s = "Updated settings"
					update_status(s,false)
					await connect_roon()
					await start_heos()
				} else {
					console.log("-> ",get_date(),"RHEOS: SETTINGS  : NO CHANGES DETECTED")
					update_status("No changes detected",false)
				}	
				if (selected.default_player_ip !== changed.default_player_ip) {
					setTimeout(()=>{
						delete rheos.connection
						start_heos()
					},3000)
					console.log("-> ",get_date(),"RHEOS: RESTARTING WITH CONNECTION TO ",settings.values.default_player_ip )
					update_status("Restarting With Connection to " + settings.values.default_player_ip,true)
				}
			    if (rheos.mysettings.logo !== settings.values.logo) {
					console.log("-> ",get_date(),"RHEOS: CHANGING LOGO TO ",settings.values.logo )
                    rheos.mysettings.logo = settings.values.logo
				}
				Array.isArray(rheos.myplayers) && rheos.myplayers.filter(o => o.pid).forEach(p => {
					const pid = String(p.pid)
					const options = ["P","M","A"]
					for (let p of options){
                    	let id = p+pid
						delete(rheos.mysettings[id]) 	
					}
				})
				rheos.mysettings.avr_control = settings.values.avr_control
				roon.save_config("fixed_groups",rheos.myfixed_groups)
				roon.save_config("players",rheos.myplayers);
				roon.save_config("settings",rheos.mysettings);
				services.svc_transport.pause_all()
				services.svc_transport.ungroup_outputs([...rheos_outputs.keys()])
				start_heos()	
			}	
			req.send_complete(l.has_error ? "NotValid" : "Success", { settings: l })
		}	
	})
	roon.init_services({
		required_services: [RoonApiTransport], provided_services: [	services.svc_status,services.svc_settings, services.svc_source_control,services.svc_volume_control], 
	})
	return (roon)
}
async function control_avr(ip,command) {
    avr_buffer[ip] = []
	Array.isArray(command) && (command = command.filter(o => o))
	if (!command) {return }
	return new Promise(async (resolve, reject) => {	
       let pos = avr_buffer[ip].findIndex(o => {o.item[0] == ip  &&!isNaN(command.slice(2,4)) })
	rheos.block_avr_update = true
	  if (pos > -1) {
				LOG && console.error ("ALREADY BUFFERED",ip,command)
		     avr_buffer[ip].splice(pos,1,{ item: Array(ip,command), resolve, reject })
	  } else {
			avr_buffer[ip].push({ item: Array(ip,command), resolve, reject })
	  }
	const is_avr = await avr_dequeue(ip).catch((err)=>{console.error(get_date(),"Deque error",err)})	
	if (is_avr[1] == error){
		reject(is_avr)
	}else {
		resolve(is_avr)
	}
		rheos.block_avr_update = false
	})
}
async function avr_dequeue(ip,res) {
    if (!avr_buffer[ip] || !avr_buffer[ip].length) {return}
	const req = avr_buffer[ip].shift()	
	if (!req) {return}
	rheos.avr[ip] = true
	const connection = new rheos_connect()
	await connection.connect({
		shellPrompt:null,
		host: ip,
		port: 23,
		echoLines: 0,
		negotiationMandatory: false,
		newlineReplace : ","
	}).catch(err => {return(err)})
	try {
		res = await connection.write(req.item[1],{timeout : 400},(err,data)=>{err || (rheos.avr[ip] = false);connection.end()})
		res = res.split(",").filter((str) => {return /\S/.test(str)})
		res.push(req.item[0])
		let x =  await connection.nextData()
		return([ip,res])	
	}
	catch {
		return([ip,new Error("NOT AN AVR")])
	}
}
async function create_zone_controls(err,count=0) {	
	let tests = []
	for (const player of Array.from(heos_players.values(), (o) => o.player)){
		if (player.model && (!player.model.includes("HEOS"))&&(!player.model.includes("Home"))&& (!player.model.includes ("MODEL")) ){
			LOG && console.log("<- ",get_date(),"AVR  : TESTING   :",player.name)
			tests.push(connect_avr(player))
		}	
	} 
	await Promise.allSettled(tests).catch((err) =>{console.error(err,"⚠  ERROR TESTING FOR AVR",player.name.toUpperCase())})	
}
async function connect_avr(player){
	return new Promise (async function(resolve,reject){
		let avr = player
		let is_avr = await control_avr(avr.ip,"Z2?").catch((err)=>{console.error(get_date(),"⚠ FAILED TO CONNECT",err)})
		if (rheos.mysettings.avr_control && Array.isArray (is_avr) && !(is_avr[1] instanceof Error)){
			await create_avr_controls(avr).catch((err)=>{console.error(get_date(),"⚠ FAILED TO CREATE AVR CONTROLS",err)})
			avr.type = "AVR"
			avr.status = update_avr_status(avr)
			resolve(player.name.toUpperCase() +" is an AVR")						    
		} else { 
			avr.type = undefined;
			reject (player.name.toUpperCase() + " is NOT AVR")
		}
	})
}
async function update_avr_status(avr,why){
	if (avr?.ip){
		return new Promise(async function (resolve) {
			const avrs = Object.entries(avr_zone_controls).filter(o => o[1]?.state?.ip == avr?.ip)
			const status = (await (control_avr(avr.ip,"\rZM?\rSI?\rMV?\rMU?\rZ2?\rZ2MU?\rZ?\rMS?\r")))
			roon.paired || LOG && process.stdout.write(get_date()+ (" UNPAIRED\r"))
			if(services.svc_transport && roon.paired){
				if (rheos.mysettings.avr_control ){
					let s = new Set ([...status[1]])
					let index = 0
					for await (let control of avrs){
						const op = rheos_outputs.get(control[1].state.output)
						const parent = rheos_outputs.get(control[1].state.parent)
							if ((index === 0 && (s.has("ZMON") && s.has("SINET"))) || (index ===1 && (s.has("Z2ON") && s.has("Z2NET")) )) { 	
								if (control[1].state.status !== "deselected"){
									control[1].state.status = "selected"
									control[1].update_state({supports_standby : false , status : "deselected"})
									await create_avr_zone(avr,index)		
								}
							} else if(index == 2 ){
							
								const MV = [...status[1]].find(o => o.includes ("MS"))?.slice(2).toUpperCase() 
								if (MV && !(control[1]?.state?.display_name?.toUpperCase()).includes(MV)){
									LOG && console.log("-> ",get_date(),"AVR  : SOUND MODE:",avr?.name.toUpperCase(),(MV))
									control[1].state.display_name  = MV
									control[1].update_state({display_name :  avr.name + " ♫ " + to_title_case(MV), supports_standby :true, status : "indeterminate"})
								}	
							}
							else {
								control[1].state.status = "deselected"
								control[1].update_state({supports_standby :true, status : "deselected"})
								if (control[1].state.output ){
									services.svc_transport.ungroup_outputs([control[1]?.state.output])
									rheos_outputs.delete(control[1].state?.output)
									delete control[1].state.output 
									await kill_avr_output((Math.abs(control[1].state.pid)+(control[1].state.index)))
								}	
							}
						if (op && index == 0){
							const level= ([...s].find((o)=> (/MV\d/).test(o)).slice(2))
							if(level !== op.volume.value){
								op.volume.value = level
								services.svc_transport.change_volume(op,'absolute',level)
							}
							if (s.has("MUON")){
								services.svc_transport.mute(op,'mute')
							} else if (s.has("MUOFF")){
								services.svc_transport.mute(op,'unmute')
							}	
						} else if (op && index == 1){
							let level = ([...s].find((o)=> (/Z2\d/).test(o)).slice(2) )
							if(level != op.volume.value){
								op.volume.value = level
								services.svc_transport.change_volume(op,'absolute',level)
							}  
							if (s.has("Z2MUON" && !op.volume.is_muted)){
								LOG && console.log("-> ",get_date(),"AVR  : UNMUTE",index === 0?  avr?.name + "​ Main​ Zone": avr?.name + "​ Zone​ 2")
								services.svc_transport.mute(op,'mute')
							} else if (s.has("Z2MUOFF" && op.volume.is_muted)){
								LOG && console.log("-> ",get_date(),"AVR  : SET MUTE",index === 0?  avr?.name + "​ Main​ Zone": avr?.name + "​ Zone​ 2")
								services.svc_transport.mute(op,'unmute')
							}	
						}
						avr.status = s
						let a = Number([...s].find((o)=> (/MV\d/)?.test(o))?.slice(2))
						let b = Number([...avr.status].find(o => (/Z2\d/)?.test(o))?.slice(2))
						let max = Math.max(parent?.volume?.value,a,b)
						if (parent?.volume){parent.volume.value = max}
						services.svc_transport.change_volume(avr.output,'absolute',max)	
						index ++
					}					
				resolve(s)
				} 
			} else {
				reject()
			}	
		})
	}	
}
async function create_avr_zone(avr,index){
	LOG && console.log("-> ",get_date(),"AVR  : ZONE ON   :",index === 0?  avr?.name + "​ Main​ Zone": avr?.name + "​ Zone​ 2")
	const hex = ((Math.abs(avr?.pid)+(index+1)).toString(16))
	if (! rheos.processes[hex]){
		const mac = "bb:bb:"+ hex.replace(/..\B/g, '$&:').slice(-11)
		rheos.processes[hex] = spawn(squeezelite,["-M", index === 0?  avr?.name + "​ Main​ Zone": avr?.name + "​ Zone​ 2","-m", mac,"-o","-","-Z","192000"])
	} else {
		LOG && console.warn("-> ",get_date(),"RHEOS: WARNING   ⚠ AVR ZONE ALREADY EXITS",rheos.processes[hex].spawnargs[2])
	}
}
async function create_avr_controls(player){	
	player = heos_players.get(player.pid)?.player
		for (let index = 1; index < 3; index++) {
			switch (index) {
				case 1 :
					LOG && console.log("-> ",get_date(),"RHEOS: CREATING  : AVR CONTROL",  player?.name +  "​ Main​ Zone")
				break
				case 2 :
					LOG && console.log("-> ",get_date(),"RHEOS: CREATING  : AVR CONTROL",  player?.name + "​ Zone​ 2")
				break		
			}
			if (!avr_zone_controls[(Math.abs(player.pid)+index).toString()]){
				let controller = {    
					state: {
						control_key: (Math.abs(player.pid)+index.toString()),
						display_name : index == 1?  player?.name + "​ Main​ Zone": player?.name + "​ Zone​ 2",
						supports_standby:  false,
						status:  'indeterminate',
						pid : player.pid,
						ip : player.ip,
						index : index,
						parent : player.output
					},  
					convenience_switch : async function (req) {
						if (avr_zone_controls[(Math.abs(player.pid)+index).toString()].state.status == "standby"){
							LOG && console.log("SELECT CONVENIENCE SWITCH",this.state.display_name)
						}
						req.send_complete("Success")						
					},  
					standby:  async function (req) {
					    avr_zone_controls[(Math.abs(player.pid)+index).toString()].update_state({ status : "indeterminate"})
						avr_zone_controls[(Math.abs(player.pid)+index).toString()].state.status = "standby"
						rheos.block_avr_update = true
						await control_avr( this.state.ip,this.state.index == 1 ?  "ZMON" : "Z2ON" ).catch(()=>{console.error("⚠ ERROR SETTING AVR POWER")})
						await control_avr( this.state.ip,this.state.index == 1 ?  "SINET" : "Z2NET" ).catch(()=>{console.error("⚠ ERROR SETTING AVR TO NETWORK")})
						await update_avr_status(heos_players.get(this.state.pid),"standby").catch(()=>{console.error("⚠ ERROR UPDATING AVR STATUS")})
						rheos.block_avr_update = false
						req.send_complete("Success")
					}
				}	
				if (! avr_zone_controls[(Math.abs(player.pid)+index).toString()]){
					avr_zone_controls[(Math.abs(player.pid)+index).toString()]	= services.svc_source_control.new_device(controller)	
				} 
				const state = controller.state
				avr_zone_controls[(Math.abs(player.pid)+index).toString()].state = state
			}
		}
		if (!avr_zone_controls[(Math.abs(player.pid)).toString()]) {
			let controller = {    
				state: {
					control_key: (Math.abs(player.pid)).toString(),
					display_name: (player?.name + " ♫ Sound Mode"),
					supports_standby: true,
					status:  "indeterminate",
					parent :player.output,
					pid : player.pid,
					ip : player.ip,
					name : player.name		
				},  
				convenience_switch : async function (req) {
					setTimeout(	()=> { req.send_complete("Success") },500	)		
				},  
				standby:  async function (req ) {
					await update_control(this.state).catch(() => {console.error("⚠ ERROR STANDING BY",this.state.display_name)})	
					req.send_complete("Success")
				}
			}
			if (!avr_zone_controls[(Math.abs(player.pid)+3).toString()] ) {
				avr_zone_controls[(Math.abs(player.pid)+3).toString()]	= services.svc_source_control.new_device(controller)
				avr_zone_controls[(Math.abs(player.pid)+3).toString()].state = controller.state
				avr_zone_controls[(Math.abs(player.pid)+3).toString()].update_state(controller.state)
			}
		}
		let volume_control = {
			state: {
				control_key: player.pid,
				display_name: player.name,
				volume_type : 'incremental',
				//volume_type:  "db",
				//volume_min  : -80,
				//volume_max : 18,
				//volume_step : 1.0,
				player : player
			},
			set_volume: async function (req, mode, value) {
				rheos.block_avr_update = true
				//await update_avr_volume(this.state.player,mode,value)
				req.send_complete("Success");
				rheos.block_avr_update = false
			},
			set_mute: async function (req, mode	) {
				rheos.block_avr_update = true
				//await update_avr_volume(this.state.player,mode)
				req.send_complete("Success");
				rheos.block_avr_update = false
			}
		}
		LOG && console.log("-> ",get_date(),"RHEOS: CREATING  : CUSTOM VOLUME CONTROLLER",player.name.toUpperCase())
		avr_volume_controls[player.pid] || (avr_volume_controls[player.pid] = services.svc_volume_control.new_device(volume_control))	
}
async function update_control (state){
	const{name,ip,pid}=state
	const player = heos_players.get(pid)?.player
	LOG && console.log("-> ",get_date(),"RHEOS: UPDATING  : AVR SOUND MODE",player.name.toUpperCase())
    let present = [...player.status].find((o)=> o.includes("MS"))
	let present_mode_index = sound_modes.findIndex((sm) => sm == present)
	let next = (present_mode_index < sound_modes.length-1 ? sound_modes.at(present_mode_index+1): sound_modes.at(0))
	LOG && console.log("-> ",get_date(),"RHEOS: UPDATING  : AVR SOUND MODE",player.name.toUpperCase(),"from",present,"to",next)
	await control_avr( ip, next).catch(()=>{console.error("⚠  ERROR UPDATING SOUND MODE ",name,ip,next)})
    await update_avr_status(heos_players.get(pid)?.player)
}
async function kill_avr_output(pid){
	const hex = (pid.toString(16))	
	if (rheos.processes[hex]?.pid){
		process.kill( Number(rheos.processes[hex]?.pid),'SIGKILL') 
		delete rheos.processes[hex]
	}	
}
async function update_outputs(outputs,cmd){
	if (cmd === "removed"){
		outputs.forEach(op => rheos_outputs.delete(op))
		return
	}
	let heos_player = {}
	return new Promise(async function (resolve) {
	for await (const op of outputs) {	
		if(Array.isArray(op?.source_controls)){
			const {display_name} = op?.source_controls[0]
			if (display_name.includes("RHEOS") ){
				LOG && console.log("<- ",get_date(),"RHEOS: OUTPUT    :",cmd.toUpperCase(),display_name)
				heos_player = heos_players.get(unhide_value(op.source_controls[0].display_name))
				if (heos_player){
					heos_player.output = op
				}
				rheos_outputs.set(op.output_id,op)
				//if (heos_player?.type == "AVR" &&  diff !== 0){
				//	await update_player_volume(op,heos_player)
				//} 
			} else if (display_name.includes ("🔗")){	
			    const fixed = fixed_groups.get(unhide_value(display_name))
				if (fixed) fixed.output = op
			} else if (display_name.includes("​")) {
				LOG && console.log("<- ",get_date(),"RHEOS: AVR OUTPUT:",cmd.toUpperCase(),display_name,op.volume.value)
				const control  = Object.values(avr_zone_controls).find(o => o.state.display_name == display_name)				
				if (cmd.toUpperCase() == "ADDED" && control){
					control.update_state({output : op.output_id})
					let zone = services.svc_transport.zone_by_output_id(control.state.parent) 
					let output = rheos_outputs.get(control.state.parent)
					if (output){
						if (output?.grouping) {
							clearTimeout(output.delay_group)
							control.state.output && output.grouping.add(control.state.output)
						} else if (output){
							output.grouping = new Set(zone.outputs.map((o)=>o?.output_id).concat(control.state.output).filter ((o)=> o))
						} 
						output.delay_group = setTimeout(()=>{
							output.grouping.size >1 &&
							services.svc_transport.group_outputs([...output.grouping],output.grouping.delete())
						},500)
					}		
				}
				if (control) {
						const{state:{ip,index}} = control
						ip && control_avr(ip,(index === 1 ? "MV" : "Z2")+op.volume.value)
					if (op.volume.is_muted) {
						ip && control_avr(ip,(index === 1 ? "MU" : "Z2MU")+(op.volume.is_muted ? "ON" : "OFF"))
					}
				}
				rheos_outputs.set(op.output_id,op)
			}
		} 
		if (op?.volume?.value > rheos.mysettings.max_safe_vol){
			services.svc_transport.change_volume(op,"absolute",rheos.mysettings.max_safe_vol)			
		}	
	}	
	resolve()
	}).catch(err => console.error(get_date(),"⚠ ERROR UPDATING OUTPUTS",err))		
}		
async function update_zones(zones,added){
	return new Promise(async function (resolve) {
		for await (let z of zones) {		
			if (z.outputs){		
				const index = z.outputs.findIndex(o => o.source_controls[0].status == "standby")	
				if (index>-1){	
					if (player && Array.isArray(player?.PWR)&& !z.outputs[index]?.source_controls[0]?.display_name?.includes("​")){
						rheos.block_avr_update = true
						player.PWR = await control_avr(player?.ip,"PW?")
						if (Array.isArray(player.PWR) && player.PWR.includes("PWSTANDBY")){
							await control_avr(player.ip,"PWON")
							if (Number(player.auto_play )> -1){
								setTimeout(async (output)=> {	
									await control_zone(services.svc_transport.zone_by_output_id(output),"play")
								},player.auto_play*1000,z.outputs[index].output_id)
							} 
						} else {
							await control_avr(player.ip,"PWSTANDBY")
						}
						rheos.block_avr_update = false
					} else if (rheos.mysettings.avr_control && z.outputs[index].source_controls[0]?.display_name.includes("​")){				
						rheos.block_avr_update = true
						LOG && console.log("-> ",get_date(),"AVR  : STANDBY ZONE",z.outputs[index].source_controls[0]?.display_name)
						services.svc_transport.ungroup_outputs([z.outputs[index]]);
						const control  = Object.entries(avr_zone_controls).find(o=> o[1].state.display_name == get_output_name(z.outputs[index])	)	
						if (control){
							let {state : {pid,ip,index}} = control[1]	
							let avr_status = heos_players.get(pid).player.status
							if (typeof(avr_status) == 'object'){
								if (index == 1 && avr_status.has( "SINET") || index == 2 &&  avr_status.has("Z2NET")){
									await control_avr(ip,index == 1 ? "ZMOFF" : "Z2OFF")
								}
							}	
						}	
						rheos.block_avr_update = false	
					}	
				} 		
				if ( rheos.mysettings.avr_control && (z.outputs[0].source_controls[0]?.display_name).includes("​")){
					const control  = Object.values(avr_zone_controls).find(o => o.state.display_name == get_output_name(z.outputs[0]))
					if (control){
						rheos.block_avr_update = true
						let {update_state, state : {pid,status,display_name}} = control
						if (status === "selected"){
						    await kill_avr_output((Math.abs(control.state.pid)+(control.state.index)))
							update_state({supports_standby: true, status :"standby" })
							status = "standby"
						}  
						else if (status === "standby" && heos_players.get(pid)){
							const  group = (services.svc_transport.zone_by_output_id(control.state.parent)?.outputs)
							if (group){group.map ((o) => o.output_id).push(z.outputs[0].output_id)
								setTimeout(() =>{
									services?.svc_transport && group && services.svc_transport.group_outputs(group)
								},500)
							}	
						}
						rheos.block_avr_update = false
					}
				} 		
			} 
		}
		resolve()
	}).catch(err => console.error("-> ",get_date(),"RHEOS: ZONE    ⚠ ERROR UPDATING ZONES",err))	
}
async function update_avr_volume(player,mode,value){  
	if (mode == 'relative'){
		await heos_command("player", value == 1 ? "volume_up" : "volume_down", { pid: player?.pid, step: 1 }).catch(err => console.error(get_date(),err))
		if (player?.output){
			let zone = (services.svc_transport.zone_by_output_id(player.output))
			for (let o of zone.outputs){
				if (get_output_name(o).includes("​")){
					services.svc_transport.change_volume(o,mode,value)
				}
			}
		}	
	} 
	else if (mode == 'absolute'){
		if (player?.output){
			let zone = (services.svc_transport.zone_by_output_id(player?.output))
			for (let o of zone.outputs){
				services.svc_transport.change_volume(o,mode,value)
			}
		}	
	} 
	else if (mode == 'toggle'){
		await heos_command("player", "toggle_mute",{ pid: player?.pid}).catch(err => console.error(get_date(),err))
        let zone = (services.svc_transport.zone_by_output_id(player.output))
		for (let o of zone.outputs){
            if (get_output_name(o).includes("​")){
				services.svc_transport.mute(o,o.volume.is_muted ? 'unmute' : 'mute')
			}
		}	
	} 
}	
async function start_listening() {
	await heos_command("system", "prettify_json_response", { enable: "on" },true).catch(err => console.error(get_date(),"⚠ Failed to set responses"))
}
async function connect_roon() {
	return new Promise(async function (resolve,reject) {
		const roon = new RoonApi({
			extension_id: "com.RHEOS.latest",
			display_name: "Rheos",
			display_version: version,
			publisher: "RHEOS",
			email: "rheos.control@gmail.com",
			website: "https:/github.com/LINVALE/RHEOS",
			log_level:  "none",
			force_server: true,
			core_paired: async function (core) {
				LOG && console.log("-> ",get_date(),"RHEOS: PAIRED    :",roon.extension_reginfo.extension_id)
				LOG && console.log("-> ",get_date(),"RHEOS: SERVER    : IP ADDRESS",roon.paired_core?.moo?.transport?.host || "NOT KNOWN")
				roon.paired = true
				rheos.mysettings.host_ip =  roon.paired_core?.moo?.transport?.host  
				await set_server(rheos.mysettings.host_ip )	
				services.svc_transport = core.services.RoonApiTransport	
				services.svc_transport.subscribe_outputs(async function (cmd, data) {	
					if (cmd == "NetworkError") reject (roon)
					let removed = data?.outputs_removed || []
					let changed = data?.outputs_changed && data.outputs_changed.filter(o => o.source_controls && (o.source_controls[0].display_name.includes ("RHEOS") || o.source_controls[0].display_name.includes ("🔗")) ) || [];
					let added =   data?.outputs_added || []
					let avr_changes = data?.outputs_changed && data.outputs_changed.filter(o => o.source_controls && (o.source_controls[0].display_name.includes("​"))) || []
					if (data?.outputs_added){
						for (let o of data?.outputs_added){
						    if (o.source_controls && (o.source_controls[0].display_name.includes ("RHEOS") || o.source_controls[0].display_name.includes ("🔗")) ){
								const heos_player = heos_players.get(unhide_value(o.source_controls[0].display_name))
								o.pid = heos_player?.player?.pid
								rheos_outputs.set(o.output_id,o)
								heos_player?.player && 	(heos_player.output = o);
								o && services.svc_transport.ungroup_outputs([o]) 
							} 
						}
					}
					if (data?.outputs_changed){
						for (let o of data?.outputs_changed){
							if (Array.isArray(o?.source_controls)){
								if (o?.source_controls[0]?.display_name?.includes ("🔗")){
								const fixed = fixed_groups.get(unhide_value(o.source_controls[0].display_name))
								fixed.output = o
								continue
								}
								const heos_player = heos_players.get(unhide_value(o.source_controls[0].display_name))
								if (heos_player){
									heos_player.output = o
								}
							} 
							
						}
					}
				//	avr_changes.length && await update_outputs(avr_changes,"avr")
				})
				services.svc_transport.subscribe_zones(async function (cmd, data) {
				if (cmd == "NetworkError") reject (roon)
					const removed = data?.zones_removed || []
						for (let z of removed){
							rheos_zones.delete(z)								
						}	
					const added = data?.zones_added || []
					for (let z of added){
						   const fixed = fixed_groups.get(unhide_value((z.outputs.find(o => o.source_controls[0].display_name.includes("🔗")))?.source_controls[0]?.display_name)) 
							if (fixed){
								fixed.zone = z
							}
							const player = heos_players.get(unhide_value(z.outputs[0].source_controls[0].display_name))
						if (player) {
							player.zone = z
							if (z.outputs.length == 1 && player.pid == player?.gid){
								await group_enqueue([player.pid])
							}
						}
						if (z.outputs.length >1){
							let zone = rheos_zones.get(z.zone_id)
							if (! zone){
								zone =rheos_zones.set(z.zone_id,new Heos_group(z)).get(z.zone_id)
							}
								zone.zone = z		
						} 
					}
					let changed = []
					if (data?.zones_changed ){
						changed = data.zones_changed.filter(o => (o.outputs[0]?.source_controls[0].display_name.includes ("🔗") || o.outputs[0]?.source_controls[0].display_name.includes ("RHEOS") ) )|| []
					}
					for (let z of changed){
						let zone = rheos_zones.get(z.zone_id)
						zone && (zone.zone = z)
						const fixed = fixed_groups.get(unhide_value((z.outputs.find(o => o.source_controls[0].display_name.includes("🔗")))?.source_controls[0]?.display_name)) 
						const player = heos_players.get(unhide_value(z.outputs[0].source_controls[0].display_name))
						if (player) {
							player.zone = z
						}
						if (fixed){
							fixed.zone = z
						}
					}
				})
				await start_listening().catch((err) => {console.error(get_date(),"⚠ Error Starting Listeners",err);reject()})
			},
			core_unpaired: async function (core) {
				console.error("-> ",get_date(),"RHEOS: WARNING   ⚠ CORE UNPAIRED");
				roon.paired = false
				core = undefined
				start_roon(true)
			},
			onclose: async function (core) {
				console.error("-> ",get_date(),"RHEOS: WARNING   ⚠ CORE CLOSED");
				roon.paired = false
				core = undefined	
				try{
					exec("pkill -f -9 UPnP")
					exec("pkill squeezelite")
				} catch{
					LOG && console.warn("-> ",get_date(),"RHEOS: WARNING   ⚠ No UPnP/Squeezelite Processes Identified to Kill on closing core")
				}
			}
		})
		if (roon){
			resolve (roon)
		} else {
			console.error("-> ",get_date(),"ERROR ⚠ NO ROON API FOUND PLEASE CHECK YOUR ROON SERVER IS SWITCHED ON AND ACCESSIBLE AND TRY AGAIN");
			reject
		}
	})
}
async function set_server(ip) {
	try {
	  console.log("<- ",get_date(),"RHEOS: SERVER    : IMAGE SERVICE STARTED ON PORT : 9330")
	  await fs.writeFile('./UPnP/Profiles/server', ip + ":9330");
	} catch (err) {
	  console.log("ERROR ON SERVER",err);
	}
}
async function control_zone(zone,control){
	return(new Promise((resolve, reject) => {
			services.svc_transport.control(zone,control, resolve)		
		})
	)
}	
function makelayout(settings) {
	const players = Array.from(heos_players.values(), (o) => o.player)
	const ips = players.map(player => player?.name && new Object({ "title": player.model + ' (' + player.name.toUpperCase() + ') ' + ' : ' + player.ip, "value": player.ip }))
	ips.push({ title: "No Default Connection", value: 0})
	let l = {values: settings,layout: [],has_error: false}
	l.layout.push(ips.length > 1 ? { type: "dropdown", title: "Default Heos Connection", values: ips, setting: "default_player_ip" }: { type: "string", title: "Default Heos Player IP Address", maxlength: 15, setting: "default_player_ip" })
	l.layout.push({ title: "Enable AVR Zone Control ", type: "dropdown", setting: 'avr_control', values : [{title: "ON", value : 1},{title : "OFF", value :0}]})
	l.layout.push({ title: "Enable Fixed HEOS Groups ", type: "dropdown", setting: 'fixed_control', values : [{title: "ON", value : 1},{title : "OFF", value :0}]})
	l.layout.push({ title: "Display Logo ", type: "dropdown", setting: 'logo', values : [
		{title: "ROON LIGHT", value : "roon_light.png"},
		{title: "ROON DARK", value : "roon_dark.png"},
		{title: "RHEOS LIGHT", value : "rheos_light.png"},
		{title: "RHEOS DARK", value : "rheos_dark.png"},
		{title: "RHEOS RED", value : "RED.png"},
		{title: "RHEOS SEASONAL", value : "Holiday.png"}
	]})
	if (players.length) {
		let _players_status = { type: "group", title: "PLAYER AUDIO RESOLUTION", subtitle: "Set player resolution", collapsable: true, items: [] }
		for (let player of players){
			if (player.name) {
				_players_status.items.push({title: ('◉ ') + player.name.toUpperCase(),type: "dropdown",
				values: [{ title: "Hi-Resolution", value: "HR" }, { title: "CD Quality", value: "CD" },{ title: "Pass Through", value: "THRU"},{title : "Pass Through Low Res" , value : "LOW"}],
				setting: "P"+String((player.pid))
				})
			}
		}
		l.layout.push(_players_status)
		const _players_mode = { type: "group", title: "PLAYER DISPLAY MODE", subtitle: "Set player display options", collapsable: true, items: [] }
		for (const player of players){
			if (player.name ) {
				_players_mode.items.push({title: ('◉ ') + player.name.toUpperCase(),type: "dropdown",
				values: [{ title: "Off", value: "OFF" },{ title: "Flow Mode", value: "FLOW" }, { title: "Meta Data Only", value: "META"}, {title: "Album Art Only", value: "ALBUM"}, {title: "Meta and Album Art", value: "ART"}],
				setting: ("M"+String((player.pid)))
				})
			}
		}
		l.layout.push(_players_mode)
	}
	let _avrs = { type: "group", title: "AUTO PLAY", subtitle: "Set for devices with power ON/OFF", collapsable: true, items: [] };
	for (const player of heos_players) {
		if (Array.isArray(player[1].PWR)) {
			let values = [
				{title : "OFF", value :"-1"},
				{title : "No-Delay", value :"0"}]
				for (let i = 0; i < 21; i++) {
					values.push ({title : i, value : i})
				}
			_avrs.items.push({title: player[1].name, subtitle: "Set delay (secs)",type: "dropdown",values: values, setting: ("A"+String(Math.abs(player[1].pid)))})
		}
	}
	l.layout.push(_avrs)
	if (rheos.mysettings.fixed_control){
		const _fixed_groups = { type: "group", title: "FIXED GROUPS", subtitle: "Create fixed groups of players", collapsable: true, items: [] };
		for (let group of get_all_groups()) {
			let name = group[1].name 
			let values = []
			values.push({title: "HI RES FIXED GROUP", value: 192000})	
			values.push({title: "CD RES FIXED GROUP", value: 48000})	
			values.push({title: "DELETE GROUP", value: -1})
			_fixed_groups.items.push({	title: name, type: "dropdown", values: values, setting: group[0]})
		}
		l.layout.push(_fixed_groups)
		
	}
	l.layout.push({
		type: "group", title: "UPnP SETTINGS ", subtitle: "Experimental settings for UPnP devices",collapsable: true, items: [
		{ title: "● Buffer Size", type: "dropdown", setting: 'streambuf_size', values: [{ title: "Small", value: 524288 }, { title: "Medium", value: 524288 * 2 }, { title: 'Large', value: 524288 * 3 },{ title: 'Giant', value: 524288 * 5},{ title: 'Unlimited', value: ""}] },
		{ title: "● Output Size", type: "dropdown", setting: 'output_size', values: [{ title: 'Small', value: 4194304 }, { title: 'Medium', value: 4194304 * 2 }, { title: 'Large', value: 4194304 * 3 },{ title: 'Unlimited', value: ""}] },
		{ title: "● Stream Length", type: "dropdown", setting: 'stream_length', values: [{ title: "No length", value: '-1' }, { title: 'Chunked', value: '-3' }, { title: 'If known', value: '-2' },{ title: 'Estimated', value: '0' }]  },
		{ title: "● Seek After Pause", type: "dropdown", setting: 'seek_after_pause', values: [{ title: "On", value: 1 }, { title: 'Off', value: 0 }] },
		{ title: "● Volume On Play", type: "dropdown", setting: 'volume_on_play', values: [{ title: "On Start Up", value: 0 }, { title: 'On Play', value: 1 }, { title: "Never", value: -1 }] },
		{ title: "● Volume Feedback", type: "dropdown", setting: 'volume_feedback', values: [{ title: "On", value: 1 }, { title: 'Off', value: 0 }] },
		{ title: "● Accept Next URI", type: "dropdown", setting: 'accept_nexturi', values: [{ title: "Off", value: 0 }, { title: 'On', value: 1 }, { title: "Force", value: -1 }] },
		{ title: "● Cache", type: "dropdown", setting: 'cache', values: [{ title: "Memory", value: 0 }, { title: 'Infinite', value: 1 }, { title: "Disk", value: 3 }] },
		{ title: "● Flac Header", type: "dropdown", setting: 'flac_header', values: [{ title: "None", value: 0 }, { title: 'Set sample and checksum to 0', value: 1 }, { title: "Reinsert fixed", value: 2 }, { title: "Reinsert calculated", value: 3 }] },
		{ title: "● Keep Alive", type: "integer", setting: 'keep_alive', min: -1, max: 120},
		{ title: "● Next Delay", type: "integer", setting: 'next_delay', min: 0, max: 60 },
		{ title: "● Log File Size Limit (MB) -1 for unlimited", type: "integer", setting: 'log_limit', min: -1, max: 10 }
		]
	})
	l.layout.push({
		type: "group", title: "REFRESH HEOS PLAYERS" , subtitle :"Use if new or removed player not automatically detected", collapsable: true, items: [
			{ title: "● REFRESH HEOS PLAYERS", type: "dropdown", setting: 'refresh_players', values: [{ title: "YES", value: 1},{ title: "NO", value: 0} ] },
		]
	})
	l.layout.push({
		type: "group", title: "REBOOT HEOS SERVER" , subtitle :"Use to reboot serving HEOS device - this will require a restart of RHEOS", collapsable: true, items: [
			{ title: "● REBOOT HEOS SERVER", type: "dropdown", setting: 'reboot_heos', values: [{ title: "YES", value: 1},{ title: "NO", value: 0} ] },
		]
	})
	l.layout.push({
		type: "group", title: "RESET ALL SETTINGS" , subtitle :" Changes are irreversible, use with caution", collapsable: true, items: [
			{ title: "● RESET STATUS TO DEFAULTS", type: "dropdown", setting: 'clear_settings', values: [{ title: "YES", value: 1}, { title: "NO", value: 0}] },
		]
	})
	l.has_error = (((l.values.host_ip !== "" && !validateIPAddressOptimized(l.values.host_ip))))
	l.has_error && console.error("-> ",get_date(),"⚠  RHEOS ERROR: INVALID IP ENTRY",l.values.host_ip)
	return (l)
}

function get_pid_by_op(op) {
	if (heos_players.size ) {
		let player = Array.from(heos_players.values(), (o) => o.player).find((player) => player?.output === op)
		return player?.pid || 0
	}
}
function get_output_name(output,print){
	if (!output.source_controls) return("NO CONTROLS")
	if (output.source_controls[0]?.display_name.includes('🔗')){
		return (output.display_name)
	} else if (output.source_controls[0]?.display_name.includes('​')){
		return (output.source_controls[0]?.display_name)
	} else if (output.source_controls[0]?.display_name.includes("RHEOS")){
		return (output.source_controls[0]?.display_name.substring(0, output.source_controls[0]?.display_name.indexOf("(RHEOS")).trim())
	} else if(print && output.display_name.includes("ROON")){ 
		console.log("NOT A RHEOS OUTPUT",output)
		return ("NOT ATTACHED")
	}
}
