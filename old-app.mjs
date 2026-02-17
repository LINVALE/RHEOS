const version = "0.12.2"
"use strict"
process.on('uncaughtException', function (err) {
  console.log("UNCAUGHT EXCEPTION",err);
});
import RoonApi from "node-roon-api"
import RoonApiSettings from "node-roon-api-settings"
import RoonApiStatus from "node-roon-api-status"
import RoonApiTransport from "node-roon-api-transport"
import RoonApiImage from "node-roon-api-image"
import RoonApiSourceControl from "node-roon-api-source-control"
import RoonApiVolumeControl from "node-roon-api-volume-control"
import child from "node:child_process"
import fs from "node:fs/promises"
import os from "node:os"
import ip from "ip"
import HeosApi from "heos-api"
import process,{pid, title} from "node:process"
import { clearTimeout } from "node:timers"
import {TIMEOUT,SHORTTIMEOUT,LOG, heos_players} from "./config.js"
import {Heos_group} from "./src/heos_group.mjs"
import {Heos_avr} from "./src/heos_avr.mjs"
import {Fixed_group} from "./src/fixed_group.mjs"
import {choose_binary} from "./src/utils.mjs"
import {heos_command , get_outputs, get_players,get_all_groups,set_players,monitor_status, group_enqueue,attachMetadataSocket,preloadNextTrackMetadata} from "./src/heos_utils.mjs"
import {init_signal_handlers,to_title_case,suppressExperimentalWarnings,validateIPAddressOptimized,get_date,hide_value,unhide_value} from "./src/utils.mjs"
import {listeners} from "./src/listeners.mjs"
import { update_status } from "./src/utils.mjs"
import {noteRoon} from "./src/bridge-proxy.mjs"
import { startBridgeProxy } from "./src/bridge-proxy.mjs";
import { preloadMetadataForZone } from "./src/heos-preload.mjs";
import { startStatusServer } from './src/status_server.mjs';
//import { handleZoneChange , clearSharedMemory, clearSlotById} from "./src/zone_change_handler.mjs";
//import { openZoneBlock, updateZoneBlock } from './src/zone-handler.mjs';
import { setTimeout as delay } from "node:timers/promises";
import { startServer } from "./fallback-image-server/server.mjs";
//import { writeZoneState } from './shm-writer.js';





export const services = {svc_status:{},svc_transport :{},svc_volume_control :{},svc_settings : {},svc_source_control : {}}
export const rheos_zones = new Map()
export const rheos_outputs = new Map()
export const rheos_groups = new Map()
export const rheos = {processes:{},mode:false, discovery:0,working:false,ready : false, avr:{},has_avr:false,system_info:[ip.address(),os.type(),os.hostname(),os.platform(),os.arch()],myfixed_groups:[],fixed_group_control:{},block_avr_update:false,base_groups : []}
export const fixed_groups = new Map()
export const all_groups = new Map()
export const squeezelite ="squeezelite" 
export const roon = await connect_roon().catch((err)=> {console.error(get_date(),"Failed to connect with ROON server",err)})
export const AVR_outputs = {}


const exec = child.execSync
const spawn = child.spawn

suppressExperimentalWarnings(process)
init_signal_handlers()
rheos_zones.groups = new Set()
startServer()



export function debugSharedMemoryInfo() {
  console.log('🧪 Node.js PID:', process.pid);
  console.log('🧪 Node.js UID:', process.getuid?.());

  try {
    const stat = statSync('/dev/shm/roon_meta_map');
    console.log('🧪 /dev/shm/roon_meta_map stat:');
    console.log(`  Size: ${stat.size} bytes`);
    console.log(`  Inode: ${stat.ino}`);
    console.log(`  Mode: ${stat.mode.toString(8)}`);
    console.log(`  UID: ${stat.uid}, GID: ${stat.gid}`);
  } catch (err) {
    console.error('❌ Failed to stat /dev/shm/roon_meta_map:', err.message);
  }

  try {
    const ls = execSync('ls -l /dev/shm/roon_meta_map').toString();
    console.log('🧪 ls -l /dev/shm/roon_meta_map:\n', ls);
  } catch (err) {
    console.error('❌ Failed to ls /dev/shm/roon_meta_map:', err.message);
  }
}



//startStatusServer(9333)

await start_up().catch((err) => console.error("⚠ ERROR STARTING UP",err))

export async function start_up(restarting = false){
	if (restarting){
		console.log ("STATE OF PLAYERS",heos_players)
	}
	console.log("-> ",get_date(),"RHEOS: SYSTEM    :",rheos.system_info.toString(),"Version :",roon.extension_reginfo.display_version, "NODEJS VERSION:",process.version)
	return new Promise (async function (resolve,reject)	{
	try{
		exec("pkill -f -9 UPnP")
        exec("pkill squeezelite")
	} catch{
		console.warn("-> ",get_date(),"RHEOS: WARNING   ⚠ No UPnP/Squeezelite Processes Identified")
	}
	
	
	//await delay(1000)

	
    
	await start_roon().catch(err => console.error(get_date(),"⚠ Error Starting Roon",err => {throw err(err),reject()}))
	await listeners().catch(err => console.error(get_date(),"⚠ Error Adding Listeners",err => {console.error(rheos.connection),reject()}))
	await start_heos().catch((err) => {console.error(get_date(),"⚠ Error Starting Heos",err);reject()})
	await subscribe_outputs()
	await subscribe_zones()
	
//const auto = new BridgeAuto("./UPnP/Logs/Study.log");
//await initBridgeAuto("./UPnP/Logs/Study.log");
/** 
auto.on("bridge", ({ id, upstream, proxyPort }) => {
    console.log("🐟 New bridge detected:");
    console.log("  ID:", id);
    console.log("  Upstream:", upstream);
    console.log("  Proxy:", `http://localhost:${proxyPort}/`);
});

*/

// Start watching
//auto.watch();
	


// Example: p.bridge looks like "http://192.168.1.10:49152/stream?id=12345"



///import { startHeosProxy } from "./heosProxy.js";

//startHeosProxy({ proxyPort: 9331 });



	rheos.base_groups = await heos_command("group", "get_groups",TIMEOUT,true).catch(err => console.error(get_date(),err))

		await get_outputs(0,true);

		let linked = Array.from(heos_players.values()).filter(p => p.output);
		let activated = [...rheos_outputs.values()].filter (o => o.display_name.includes("RHEOS"))
		console.log("-> ",get_date(),"RHEOS: LINKED    :",linked.length,"HEOS PLAYERS" )
		console.log("-> ",get_date(),"RHEOS: ACTIVATED :",activated.length,"HEOS PLAYERS" )
		console.log("-> ",get_date(),"RHEOS: SERVER    : IP ADDRESS",roon.paired_core?.moo?.transport?.host)
		
	    if (linked && linked.length >1 && activated.every(o =>  linked.find (p => p.output.output_id == o.output_id))){
				let players = Array.from(heos_players.values(), (o) => o.saved_player_info)
				LOG && console.log("-> ",get_date(),"RHEOS: SAVING    :",activated.length,"ACTIVATED HEOS PLAYERS" )
				players = rheos.myplayers.map((o) => {let {output,timeout,bridge,gid,Z2,PWR,volume,zone,state,status,group,now_playing,awaiting,position,duration,rheos,next,payload,force_play,connection, ...p} = o;return(p)})
				rheos.myplayers = players
				roon.save_config("players",players);
				rheos.base_groups.payload.forEach(o => {

			//console.log("-> ",get_date(),"RHEOS: CREATING  : ROON ZONE",o.name,"FROM BASE HEOS GROUP" )
			//console.log(rheos_zones)
			//if (! rheos_zones.has(o.gid )){
			//	let g = rheos_zones.set(o.gid,new Heos_group(o)).get(o.gid)
			//	g.group=(o)
			//}
		})
			if (!linked.length){
				console.warn(" ************* PLEASE ENABLE RHEOS IN SETTINGS -> EXTENSIONS -> RHEOS ******************")
			}
		}

	const c = spawn("squeezelite")
		c.on('error', async function(err) {
	    LOG && console.warn(get_date(),'SQUEEZELITE NOT INSTALLED : LOADING BINARIES');
		squeezelite = await choose_binary("squeezelite",true).catch(err => console.error(get_date(),"⚠ Error Loading Squeezelite Binaries",err => {console.error(err),reject()}))
	})
	c.on('spawn',() => console.log("-> ",get_date(),"RHEOS: SYSTEM    : SQUEEZELITE IS INSTALLED ON OPERAING SYSTEM",os.type()))
   /process.kill(c.pid,'SIGTERM')
	console.log("-> ",get_date(),"RHEOS: SYSTEM    :",rheos.system_info.toString(),"Version :",roon.extension_reginfo.display_version, "NODEJS VERSION:",process.version)
	Fixed_group.load_fixed_groups()//.catch( err => {console.error(get_date(),"⚠ Error Loading Fixed Groups",err);reject()})
	Object.entries(rheos.mysettings).filter(o => o[0][2] && isNaN(o[0][2])).forEach(o => LOG && console.log("-> ",get_date(),"RHEOS: SETTING   :",to_title_case(o[0].padEnd(20 ,".")),o[1] ? (o[1] === true || o[1] === 1) ? "On" : o[1] : o[1]===0 ? "Off" : "Not Defined"))
	await get_outputs(0,true)
	rheos.ready = true
	resolve()
	}).catch( err => {
		console.error(get_date(),"⚠ Error Starting Up")
		process.exit(err)
	})
}
async function start_roon(restart) {
	LOG && console.log("-> ",get_date(),"RHEOS: SYSTEM    :",restart ? "RESTARTING":"STARTING","RHEOS")
	const def = JSON.parse(await fs.readFile('./default_settings.json','utf-8'))
	services.svc_status = new RoonApiStatus(roon)
	services.svc_transport = new RoonApiTransport(roon)
	services.svc_image = new RoonApiImage(roon)
	services.svc_source_control = new RoonApiSourceControl(roon)
	services.svc_volume_control = new RoonApiVolumeControl(roon)
	rheos.mysettings = roon.load_config("settings")|| def.settings || {}
	rheos.mysettings.log_limit || (rheos.mysettings.log_limit = 1)
	rheos.myplayers = roon.load_config("players") || []
	rheos.mysettings.clear_settings = 0	
	rheos.mysettings.refresh_players = 0	
	rheos.mysettings.reboot_heos = 0
	roon.start_discovery()

	if (rheos.mysettings.fixed_control){
		rheos.myfixed_groups = roon.load_config("fixed_groups") || []
		Array.isArray (rheos.myfixed_groups)  &&   rheos.myfixed_groups?.forEach(group => {
		const fixed = new Fixed_group(group)
		fixed_groups.set(Heos_group.get_group_sum_group(group),fixed)
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
			for (const group of get_all_groups()){
				if(group[1]?.sum_group){
					rheos.mysettings["F" + String(group[1].sum_group)] = (String(group[1]?.resolution))
				}	
			}
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
				let players = rheos.myplayers.map((o) => {let {output,timeout,bridge,gid,Z2,PWR,volume,zone,state,status,group,now_playing,awaiting,position,duration,rheos,next,payload,force_play,connection, ...p} = o;return(p)})
			    rheos.myplayers = players	
				for await (const group of get_all_groups()){
					if(!group[1]) continue
					group[1].resolution = settings.values["F" + group[0]] 
					if (settings.values["F" + String(group[1].sum_group)] >-1 ){
						const fixed = new Fixed_group(group[1])
						fixed_groups.set (group[0],fixed)
						rheos.myfixed_groups = Array.from(fixed_groups.values()).map(fg => fg._group)	
					} else {
						fixed_groups.get(group[0])?.remove()	
						
					}
						console.log("DELETE","F" + String(group[1].sum_group),settings)
						delete settings.values["F" + String(group[1].sum_group)]
						console.log("SETTINGS NOW",settings)

				}

				const select= ({
					default_player_ip,host_ip,port,streambuf_size,output_size,stream_length,seek_after_pause,volume_on_play,logo,volume_feedback,accept_nexturi,flac_header,keep_alive,next_delay,max_safe_vol,avr_control,fixed_control,log_limit,log,clear_settings,refresh_players,cache
			    }) => ({
					default_player_ip,host_ip,port,streambuf_size,output_size,stream_length,seek_after_pause,volume_on_play,logo,volume_feedback,accept_nexturi,flac_header,keep_alive,next_delay,max_safe_vol,avr_control,fixed_control,log_limit,log,clear_settings,refresh_players,cache
				})
				const selected = select(rheos.mysettings)
				const changed = select(settings.values)
				roon.save_config("settings", changed)
				rheos.mysettings = changed
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
		required_services: [RoonApiTransport,RoonApiImage], provided_services: [	services.svc_status,services.svc_settings, services.svc_source_control,services.svc_volume_control], 
	})
	return (roon)
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
				console.log("-> ",get_date(),"RHEOS: PAIRED    :",roon.extension_reginfo.extension_id)
				console.log("-> ",get_date(),"RHEOS: SERVER    : IP ADDRESS",roon.paired_core?.moo?.transport?.host || "NOT KNOWN")
				roon.paired = true
				rheos.mysettings.image_host_ip =  roon.paired_core?.moo?.transport?.host  
				rheos.mysettings.roon_ip =  roon.paired_core?.moo?.transport?.host 
				rheos.mysettings.image_port =  roon.paired_core?.moo?.transport?.port  
				services.svc_transport = core.services.RoonApiTransport	
				
					
	

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
					LOG && console.warn("-> ",get_date(),"RHEOS: WARNING   ⚠ No UPnP/Squeezelite Processes Identified on closing core")
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

async function subscribe_zones(){


				services.svc_transport.subscribe_zones(async function (cmd, data) {
				
				if (cmd == "NetworkError") reject (roon)
					const removed = data?.zones_removed || []
						for (let z of removed){
							const zone = rheos_zones.get(z.zone_id)
							if (zone){
								zone.now_playing = {}
								clearSlotById(zone.pid.toString())
							}
							rheos_zones.delete(z)								
						}	
					const added = data?.zones_added || []
					for (let z of added){
						const fixed = fixed_groups.get(unhide_value((z.outputs.find(o => o.source_controls[0].display_name.includes("🔗")))?.source_controls[0]?.display_name)) 
						if (fixed) {
							fixed.zone = z
							continue
						}
						const player = heos_players.get(unhide_value(z.outputs[0].source_controls[0].display_name))
						if (player) {
							player._player.socket || await attachMetadataSocket(player._player)
							//player.new_zone = z
							rheos_zones.set(z.zone_id,player)
							if (z.outputs.length == 1 && player.pid == player?.gid)	await group_enqueue([player.pid])	

  console.log("SUBSCRIBING TO Q FOR", z)

   // const transport = services?.svc_transport;
    //console.dir(transport,{depth: 2})
    //if (!transport || typeof transport.subscribe_queue !== "function") {
    //    console.warn("🚫 Transport not ready — deferring queue subscription");
    //    setTimeout(() => this.new_zone = z, 100); // retry
    //    return;
  //  }

 ////let x =  services.svc_transport.subscribe_queue(z,2)
//console.log(x)


						}	
						if (z.outputs.length >1){
							await group_enqueue(z.outputs.map(o => Number(unhide_value(o.source_controls[0].display_name))))	
						}									
					}
					let changed = []
					if (data.zones_seek_changed) {
						//data.zones_seek_changed.forEach((z) => {
						//	const zone = rheos_zones.get(z.zone_id);
							//if (!zone || !zone._player) return;

							//const player = zone._player;
							//const np = zone.now_playing;
							//const queue = player.queue;

							//np.seek_position = z.seek_position;

							//noteRoon(np.queue_item_id, z.seek_position, np.length, Date.now());

							//const nearEnd = np.length > 0 && (np.seek_position >= np.length - 2);
							//const next = queue?.[1];
							//const notPreloaded = next && next.queue_item_id !== player.last_sent_queue_id;

							//if (nearEnd && notPreloaded) {
							//	console.log("⏱ Fallback: Preloading next track due to seek nearing end");
							//	preloadNextTrackMetadata(zone);
							//}

							// Optional: auto-advance if stuck at end
							//if (next && np.length === np.seek_position + 1) {
							//	setTimeout(() => {
							//		services.svc_transport.control(zone._zone.zone_id, "next");
							//	}, rheos.mysettings.next_delay || 200);
							//}
						//});
					}
					if (data?.zones_changed ){
						changed = data.zones_changed.filter(o => (o.outputs[0]?.source_controls[0].display_name.includes ("🔗") || o.outputs[0]?.source_controls[0].display_name.includes ("RHEOS") ) )|| []
						for (let z of changed){
							console.log("******	ZONE CHANGED **********",changed)
							rheos_zones.get(z.zone_id)._zone = z
							const fixed = fixed_groups.get(unhide_value((z.outputs.find(o => o.source_controls[0].display_name.includes("🔗")))?.source_controls[0]?.display_name)) 
							const player = heos_players.get(unhide_value(z.outputs[0].source_controls[0].display_name))
							if (player?.type == "AVR") {
								player.zone = z
									let changed = z.outputs.filter(o => o.source_controls[0].status == "standby")
									if (changed[0]?.source_controls){
										player.zone_off = changed[0]?.source_controls[0]
									}
							}
							if (fixed){			
								fixed.zone = z
							}
							player && (player.zone = z)


							/**  Send metadata update to player's socket
							if (player && player._player && player._player.socket) {
								const metadata = { 
									title: z.now_playing?.three_line?.line1 || 'No Track Playing', 
									artist: z.now_playing?.three_line?.line2 || 'RHEOS', 
									album: z.now_playing?.three_line?.line3 || player.name,
									album_art:`http://${rheos.mysettings.image_host_ip}:${rheos.mysettings.image_port}/api/image/${z.now_playing?.image_key}?scale=fit&width=500&height=500&format=image/jpeg` || null,
									duration: z.now_playing?.length || 0,
									state : z.state || null	
								}; 
								//console.log("SENDING METADATA UPDATE TO PLAYER SOCKET",metadata)	
								//player._player.socket.write(JSON.stringify(metadata)+ "\n")
							}
							*/
						}
					}
				})
			}
export async function subscribe_outputs(){
	services.svc_transport.subscribe_outputs(async function (cmd, data) {	
					if (cmd == "NetworkError") reject (roon)
					if (data?.outputs){
						console.log("outputs",data)
						if (data.outputs_added){
							for (let o of data?.outputs_added){
								if (o.source_controls && (o.source_controls[0].display_name.includes ("RHEOS") || o.source_controls[0].display_name.includes ("🔗")) ){
									const heos_player = heos_players.get(unhide_value(o.source_controls[0].display_name).toString())
									if (heos_player){
										heos_player.output = o
										o.pid = heos_player?.player?.pid
										rheos_outputs.set(o.output_id,o)
										o && services.svc_transport.ungroup_outputs([o]) 
										const {model = null} = heos_player 
										if (model && (!model.includes("HEOS"))&&(!model.includes("Home"))&& (!model.includes ("MODEL")) && (!model.includes ("ND")) && (!model.includes ("LINK"))){
											const pid = heos_player.pid
											await Heos_avr.test_if_avr(heos_player)
											let p =heos_players.get(pid)
											p.output = o

										} 
										
									}
								}
								if (o.source_controls && (o.source_controls[0].display_name.indexOf(" ")>-1)){
									const heos_player = heos_players.get(unhide_value(o.source_controls[0].display_name))
									const group = heos_player?._zone?.outputs
									if (o.source_controls[0].display_name.includes("Main")){
										heos_player.MZ = o
										group.push(o)
									}
									if(o.source_controls[0].display_name.includes("Zone 2")){
										heos_player.Z2 = o
										group.push(o)
									}	
									services.svc_transport.group_outputs(group) 	
								} 

								
							}
						}
						//console.log("I SHOULD TEST OUPUT",rheos.base_groups.payload)
						//if (rheos?.base_groups?.payload?.length){

						//	for (let g of rheos.base_groups.payload){
						//		let x = Heos_group.get_group_outputs(g)
						//		Array.isArray(x) && console.log(x.map (g => g.output_id))
						//	}
						//}
						
						
					    if (data.outputs_changed){
							for (let o of data?.outputs_changed){
								if (Array.isArray(o?.source_controls)){
									if (o?.source_controls[0]?.display_name?.includes ("🔗")){	
										const fixed = fixed_groups.get(unhide_value(o.source_controls[0].display_name))
										if(fixed){
											LOG && console.log("-> ",get_date(),"RHEOS: SERVER    : FIXED OUTPUT FOUND FOR",o.display_name,fixed._group.name)
											fixed.output = o
										}
										continue
									}
									const heos_player = heos_players.get(unhide_value(o.source_controls[0].display_name))
									if (heos_player){	
										heos_player.output = o
										
									} else {
										o.display_name.includes("ROON") || console.log(" NOT RECOGNIZED AS HEOS",o.display_name)
									}	
								}
							} 
						}
						if (data.outputs_removed)	{
							console.log ("OUPUTS REMOVED INFO",data)
						}
					}					
				})

}
export async function start_heos(counter = 0) {



	if (counter == 10) { process.exit(1) }
	return new Promise(async function (resolve, reject) {
		process.setMaxListeners(32)
		if (!rheos.connection) {
			console.log("-> ", get_date(), "RHEOS: DEFAULT   : HEOS CONNECTION IP IS", rheos.mysettings?.default_player_ip || "NOT SET")
			try {
				rheos.connection = await Promise.all([HeosApi.connect(rheos.mysettings.default_player_ip), HeosApi.connect(rheos.mysettings.default_player_ip)]).catch((x) => { throw x })
				console.log("-> ", get_date(), "RHEOS: CONNECTED : DEFAULT PLAYER IP", rheos.mysettings.default_player_ip)
			} catch {
				let discovered_player = await HeosApi.discoverOneDevice().catch((x) => { console.log("-> ", get_date(), "RHEOS: DISCOVER  : NO PLAYERS FOUND"); throw x })

				if (!rheos.connection) rheos.connection = await Promise.all([HeosApi.connect(discovered_player), HeosApi.connect(discovered_player)])
				console.log("-> ", get_date(), "RHEOS: CONNECTED : FIRST DISCOVERED PLAYER AT", discovered_player)
			}
		}

		rheos.connection[0].socket.setMaxListeners(32)
		rheos.connection[1].socket.setMaxListeners(32)
		let players = await get_players()
	/** 
		for (let p of rheos.myplayers) {
			let player = players.find(({ pid }) => pid == p?.pid)
			if (player) {
				if (player?.ip && player.ip !== p.ip) {
					console.log("-> ", get_date(), "RHEOS: WARNING : ⚠ NEW PLAYER IP", player.name.toUpperCase(), player.ip)
					p.ip = player.ip
					p.network = player.network
				}
				player.resolution = p.resolution
				player.mode = p.mode
			}
		}
*/
		rheos.myplayers = players
		players = rheos.myplayers.map((o) => { let { output, timeout, bridge, Z2, PWR, volume, zone, state, status, group, now_playing, position, duration, rheos, next, payload, force_play,awaiting, ...p } = o; return (p) })
		if (Array.isArray(players) && players.length) {
			await set_players(players).catch((err) => { console.error(get_date(), "RHEOS: ERROR  ⚠ SETTING PLAYERS",err) })
			let hb = 0
			rheos.heart_beat = setInterval(async () => {
				hb++;
				if (roon?.paired) {
						services.svc_transport.get_outputs(async (err, ops) => {
							if (!err && ops) {
								const old_ops = [...rheos_outputs.values()].map(o => o?.output_id)
								const all_ops = ops.outputs.map(o => o.output_id)
								const missing_op = all_ops.filter(({ output }) => output && (!all_ops.includes(output) && old_ops.includes(output))).filter(o => { o })
								for (const op of missing_op) {
									console.warn("-> ", get_date(), "RHEOS ⚠ OUTPUT   : RESETTING", op)
									const player = (Array.from(heos_players.values(), (o) => o.player).find(({ player: { output } }) => output === op))
									let p = await heos_command("player", "get_player_info", { pid: player.pid }, 1000, true)
									if (!p) { console.log(player?.name.toUpperCase(), "IS MISSING ON HEOS ") }
								}
							} else {
								console.warn("-> ", get_date(), "ROON ⚠ OUTPUTS   : NONE DETECTED")
								clearInterval(rheos.heart_beat)
								reject()
							}
						})
					//}
					//catch {
					//	console.error("ERROR CHECKING OUTPUTS PLEASE ENABLE THE RHEOS EXTENSION")
					//}
				} else {
					console.error("ROON NOT PAIRED")
				}
				hb = await monitor_status(hb)
			}, TIMEOUT)
			resolve()
		} else {
			console.error("UNABLE TO DISCOVER PLAYERS", counter)
			counter++
			reject(setTimeout(() => { start_heos(counter) }, TIMEOUT))
		}
		resolve()
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
				values: [{ title: "Hi-Resolution", value: "HR" },
					 { title: "CD Quality", value: "CD" },
					 { title: "Pass Through", value: "THRU"},
					 {title : "Pass Through Low Res" , value : "LOW"}],
					
				setting: "P"+String((player.pid))
				})
			}
		}
		l.layout.push(_players_status)
		const _players_mode = { type: "group", title: "PLAYER DISPLAY MODE", subtitle: "Set player display options", collapsable: true, items: [] }
		for (const player of players){
			if (player.name ) {
				_players_mode.items.push({title: ('◉ ') + player.name.toUpperCase(),type: "dropdown",
				values: [{ title: "Off", value: "OFF" },
					{ title: "Flow Mode", value: "FLOW" },
					 { title: "Meta Data Only", value: "META"},
					{title: "Album Art Only", value: "ALBUM"},
					  {title: "Meta and Album Art", value: "ART"}],
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
			if (!group[0]) continue
			const {name,sum_group} = group[1]
			let values = []
			values.push({title: "HI RES FIXED GROUP", value: '192000'})	
			values.push({title: "CD RES FIXED GROUP", value: '48000'})	
			values.push({title: "DELETE GROUP", value: '-1'})
			_fixed_groups.items.push({	title: name, type: "dropdown", values: values, setting: ("F" + String(sum_group))})
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
function onZoneChanged(heosPlayer) {
  const udn = heosPlayer._player?.udn;
  const zone = heosPlayer._zone;
  const output = heosPlayer._output;

  if (!udn || !zone || !output) {
    console.warn('Missing UDN, zone, or output — skipping update');
    return;
  }

  //const block = openZoneBlock(udn);

  updateZoneBlock(block, {
    zone_id: zone.zone_id,
    display_name: zone.display_name,
    state: zone.state === 'playing' ? 1 : zone.state === 'paused' ? 2 : zone.state === 'loading' ? 3 : 0,
    seek_position_ms: zone.now_playing?.seek_position != null ? zone.now_playing.seek_position * 1000 : 0,
    duration_ms: (zone.now_playing?.length ?? 0) * 1000,
    last_position_update_ms: Date.now(),
    last_metadata_update_ms: Date.now(),
    is_previous_allowed: zone.is_previous_allowed,
    is_next_allowed: zone.is_next_allowed,
    is_pause_allowed: zone.is_pause_allowed,
    is_play_allowed: zone.is_play_allowed,
    is_seek_allowed: zone.is_seek_allowed,
    queue_items_remaining: zone.queue_items_remaining,
    queue_time_remaining_sec: zone.queue_time_remaining,
    loop_mode: zone.settings?.loop === 'loop_one' ? 2 : zone.settings?.loop === 'loop' ? 1 : 0,
    shuffle: zone.settings?.shuffle,
    auto_radio: zone.settings?.auto_radio,
    image_key: zone.now_playing?.image_key || '',
    one_line: zone.now_playing?.one_line?.line1 || '',
    two_line_1: zone.now_playing?.two_line?.line1 || '',
    two_line_2: zone.now_playing?.two_line?.line2 || '',
    three_line_1: zone.now_playing?.three_line?.line1 || '',
    three_line_2: zone.now_playing?.three_line?.line2 || '',
    three_line_3: zone.now_playing?.three_line?.line3 || '',
    output_id: output.output_id,
    output_name: output.display_name
  });
}



