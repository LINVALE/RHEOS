const version = "0.11.0"
"use-strict"
console.log("STARTING UP")
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
import process, { pid } from "node:process"
import HeosApi from "heos-api"
import RheosConnect from "telnet-client"
import express from 'express'
import tailfile from "tail-file"
import { setTimeout  as  delay} from "node:timers/promises"
import { beforeEach } from "node:test"
import { error } from "node:console"
import { clearTimeout } from "node:timers"
import { EventEmitter } from "node:events"

var log = process.argv.includes("-l")||process.argv.includes("-log")
var squeezelite ="squeezelite" 
const fixed_groups = new Map()
const all_groups = new Map()
const services = {svc_status:{},svc_transport :{},svc_volume_control :{},svc_settings : {}}
const rheos = {processes:{},mode:false, discovery:0,working:false, avr:{},has_avr:false,system_info:[ip.address(),os.type(),os.hostname(),os.platform(),os.arch()],myfixed_groups:[],fixed_group_control:{},block_avr_update:false,base_groups : []}
const roon = await connect_roon().catch((err)=> {console.error(get_date(),"Failed to connect with ROON server",err)})
const images = express('UPnP')
const start_time = new Date()
const group_buffer = []
const avr_buffer = {}
const exec = child.execSync
const spawn = child.spawn
const rheos_players = new Map()
const rheos_zones = new Map()
const rheos_outputs = new Map() 
const rheos_groups = new Map()
const avr_zone_controls = {}
const avr_volume_controls = {}
const rheos_connect = RheosConnect.Telnet
const sound_modes = ["MSSTEREO","MSDIRECT","MSPURE DIRECT","MSMCH STEREO"]
const app = await (choose_binary()).catch(err => console.error(get_date(),"Failed to find binary",err))	
const group_ready = new EventEmitter
const zone_ready = new EventEmitter
suppressExperimentalWarnings(process)
init_signal_handlers()
images.use(express.static("UPnP"))
const image_server = images.listen(0, () => {
	console.log("<- ",get_date(),`RHEOS: LISTENING : PORT ${image_server.address().port}`)
});
await start_up().catch((err) => console.error("⚠ ERROR STARTING UP",err))
async function start_up(restarting = false){
	if (restarting){

		console.log ("STATE OF PLAYERS",rheos_players)
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
	rheos.base_groups = await heos_command("group", "get_groups",10000,true).catch(err => console.error(get_date(),err))
	let link_outputs = setInterval(async () => {
		await get_outputs(0,true);
		let linked = [...rheos_players.values()].filter(p => p.output);
		let activated = [...rheos_outputs.values()].filter (o => o.display_name.includes("RHEOS"))
		log && console.log("-> ",get_date(),"RHEOS: LINKED    :",linked.length,"HEOS PLAYERS" )
		log && console.log("-> ",get_date(),"RHEOS: ACTIVATED :",activated.length,"HEOS PLAYERS" )
		log && console.log("-> ",get_date(),"RHEOS: SERVER    : IP ADDRESS",roon.paired_core?.moo?.transport?.host)
		rheos.base_groups.payload.forEach(o => {
			const players =	o.players.sort((a, b) => {let fa = a.role == "leader" ? 0 : 1; let fb = b.role == "leader" ? 0 : 1; return fa - fb} )	
			const outputs = [...rheos_outputs.values()].filter((o) => (o.source_controls && o.source_controls[0].display_name.includes("RHEOS")))
			let group = []
			for (const player of players){
				let op = outputs.find(o => o.source_controls[0].display_name.includes(player.name.toUpperCase()))
				if (op){
					group.push(op.output_id)
				}
			}
			group?.length>1 && services.svc_transport.group_outputs(group)
		})
	    if(linked.length >1 && activated.every(o =>  linked.find (p => p.output == o.output_id))){
			if (linked.length){
				rheos.listeners || 	add_listeners().catch(err => console.error(get_date(),"⚠ Error Adding Listeners",err => {console.error(rheos.connection),reject()}))
				clearInterval (link_outputs)
			} else {
				console.warn(" ************* PLEASE ENABLE RHEOS IN SETTINGS -> EXTENSIONS -> RHEOS ******************")
			}
			await create_zone_controls().catch( err => {console.error(get_date(),"⚠ Error Creating Zone Controls",err);reject()})
	
		} 
	},5000)
	let c = spawn("squeezelite")
		c.on('error', async function(err) {
	log && console.error(get_date(),'SQUEEZELITE NOT INSTALLED : LOADING BINARIES');
		squeezelite = await choose_binary("squeezelite",true).catch(err => console.error(get_date(),"⚠ Error Loading Squeezelite Binaries",err => {console.error(err),reject()}))
	})
	rheos.processes["SQUEEZELITE"] = c
	console.log("-> ",get_date(),"RHEOS: SYSTEM    :",rheos.system_info.toString(),"Version :",roon.extension_reginfo.display_version, "NODEJS VERSION:",process.version)
	await create_fixed_group_control().catch( err => {console.error(get_date(),"⚠ Error Creating Fixed Groups",err);reject()})
	rheos.mysettings.fixed_control && await load_fixed_groups().catch( err => {console.error(get_date(),"⚠ Error Loading Fixed Groups",err);reject()})
	Object.entries(rheos.mysettings).filter(o => o[0][2] && isNaN(o[0][2])).forEach(o => log && console.log("-> ",get_date(),"RHEOS: SETTING   :",to_title_case(o[0].padEnd(20 ,".")),o[1] ? (o[1] === true || o[1] === 1) ? "On" : o[1] : o[1]===0 ? "Off" : "Not Defined"))
    await restart_zones()
	await get_outputs(0,true)
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
		//	log && console.log("-> ",get_date(),"RHEOS: ZONE      : RESTART OF ZONE",zone.display_name,"MONITORED",zone.state,zone.is_play_allowed,z.now_playing.seek_position,zone.now_playing.seek_position,z.now_playing?.one_line?.line1 , zone.now_playing?.one_line?.line1 )
			if (zone?.is_play_allowed){
				services.svc_transport.control(zone,'play',(err)=> {
					err || log && console.log("-> ",get_date(),"RHEOS: ZONE      : RESTART OF ZONE",zone.display_name,"REQUESTED" )
				})			
			} else if (zone?.state == "playing" && (((zone.now_playing.seek_position - z.now_playing.seek_position) > 4)) || (z.now_playing?.one_line?.line1 !== zone.now_playing?.one_line?.line1)){
				clearInterval(timer) 
			}	
		},2000)
	})
}

async function add_listeners() {
	rheos.listeners = true
	rheos.connection[0].socket.setMaxListeners(32)
	rheos.connection[1].socket.setMaxListeners(32)
	rheos.connection[0].write("system", "register_for_change_events", { enable: "on" })
	.onClose(async (hadError,msg) => {setTimeout(async ()=>{
		console.error(get_date(),"⚠ Listeners closed socket 0", hadError,msg)
		await start_heos().catch((err) => {console.error(get_date(),"⚠ Error Starting Heos",err);reject()})
		},10000)
	})
	rheos.connection[1].write("system", "register_for_change_events", { enable: "on" })
	.onClose(async (hadError,msg) => {setTimeout(async ()=>{
		console.error(get_date(),"⚠ Listeners closed Socket 1", hadError,msg)
		await start_heos().catch((err) => {console.error(get_date(),"⚠ Error Starting Heos",err);reject()})
		},1000)
	})
	.onError((err) => {
		console.error(get_date(),"HEOS : ERROR :⚠", err)})
	.on({ commandGroup: "event", command: "groups_changed" }, async (res) => {
		log && console.log("-> ",get_date(),"HEOS : EVENT     : GROUPS CHANGED - UPDATING HEOS GROUPS")
		await update_heos_groups().then(log && console.log("-> ",get_date(),"HEOS : EVENT     : HEOS GROUPS UPDATED")).catch(err => console.error(get_date(),"⚠ Error Updating HEOS Groups",err))	
							
	})
	.on({ commandGroup: "event", command: "players_changed" }, async (res) => {
		log && console.log("-> ",get_date(),"HEOS : EVENT     : PLAYERS CHANGED")
	    clearTimeout(rheos.check_players)
		rheos.check_players = setTimeout(async () =>{
			log && console.log("-> ",get_date(),"HEOS : CHECK     : PLAYERS CHANGED")
			const players = await get_players().catch(() => {(console.error(get_date(),"Failed to create players - recomparing"))})
			const new_players = players.filter((p) => [...rheos_players.values()].findIndex((o) => o.pid == p.pid) <0)
				if (new_players.length ){
					log && console.log("-> ",get_date(),"HEOS : ADDED    : ",new_players.map(p =>p.name))
					await set_players(new_players).catch((err)=>{console.error("-> ",get_date(),"RHEOS: ⚠ ERROR   : SETTING PLAYERS", err)})
				} 	
			const removed_players = [...rheos_players.values()].filter((p) => players.findIndex((player) => player.pid == p.pid ) <0)
				if (removed_players.length){	
					log && console.log("-> ",get_date(),"HEOS : REMOVED: ",removed_players.map(p =>p.name))
					await delete_players(removed_players)
				}
		},5000)	
	})
	.on({ commandGroup: "event", command: "player_now_playing_changed" }, async (res) => {
		const {pid} = res.heos.message.parsed
		const player =  rheos_players.get(pid)			
		if(player){
			const {payload = {} } = await heos_command("player", "get_now_playing_media",{pid : pid},10000,true)
			if (payload?.mid && payload?.song !== player?.payload?.song){	
				const {mid = "",song = "",sid = ""} = payload;	
			    if (mid == '1' && sid == '1024') {
				    player.playback && clearTimeout(player.playback);		
					(player?.is_leader && player?.is_leader()) &&  log && console.log("-> ",get_date(),"RHEOS: PLAYING   :",player?.name && player?.name.toUpperCase(),player?.mode!=="FLOW" ? (payload?.album+","+payload?.song) : payload?.song)
				}	  		
				else if (player?.payload?.mid == '1' && player?.zone) {				
					services.svc_transport.control(player?.zone,"stop", async() =>{
						setTimeout(async ()=> {
						   await heos_command("player", "set_play_state",{pid : player.pid, state : "play"},10000,true)	
						},2000)
					});	
					(player?.is_leader && player?.is_leader()) &&  log && console.log("-> ",get_date(),"OTHER: PLAYING   :",player.name.toUpperCase(),payload.album,",",payload.song)
				} 
				player.payload = payload
			}
			if (player.type == "AVR"){
				await update_avr_status(player,'now_playing changed')
			}
		}	
	})
	.on({ commandGroup: "event", command: "player_state_changed" }, async (res) => {	
		const {pid,state = "unknown"} = res.heos.message.parsed
		const player =  rheos_players.get(pid)
		player && log && console.log("-> ",get_date(),"HEOS : EVENT     :",player?.name.toUpperCase(),"STATE CHANGED ",JSON.stringify(res.heos.message.parsed))
	})
	.on({ commandGroup: "event", command: "repeat_mode_changed" }, async (res) => {
		log && console.log("-> ",get_date(),"HEOS : EVENT     :","REPEAT MODE ",JSON.stringify(res.heos.message.parsed.repeat))
		const {pid,repeat} = res.heos.message.parsed
		const zone = services.svc_transport.zone_by_output_id(rheos_players.get(pid)?.output) 
		if (zone){
			switch (repeat)
			{case "on_all": 
				services.svc_transport.change_settings(zone,{loop: "loop" })
				break
			case "on_one":
				services.svc_transport.change_settings(zone,{loop: "loop_one" })
				break
			default:	services.svc_transport.change_settings(zone,{loop: "disabled" })
			}
		}
	})	
	.on({ commandGroup: "event", command: "shuffle_mode_changed" }, async (res) => {
		log && console.log("-> ",get_date(),"HEOS : EVENT     :","SHUFFLE ",JSON.stringify(res.heos.message.parsed.shuffle))
		const {pid,shuffle} = res.heos.message.parsed
		const zone = services.svc_transport.zone_by_output_id(rheos_players.get(pid)?.output) 
		if (zone){
			services.svc_transport.change_settings(zone,{shuffle : shuffle == "on"  })
		}
	})
	.on({ commandGroup: "event", command: "player_playback_error" }, async(res) => {
		const {pid,error} = res.heos.message.parsed;
		const player = rheos_players.get(pid);
		if (player){


		
		player.playback = setTimeout(async ()=> {
			
			const zone = services.svc_transport.zone_by_zone_id(player.zone)
 	
				if (zone?.is_play_allowed){
					console.log("-> ",get_date(),"RHEOS: WARNING    ⚠",player.name.toUpperCase(),"FORCING ZONE PLAY")
					//services.svc_transport.control(zone,'play')
				}
				//else if (error.includes("Unsupported")|| error.includes("decode")){
				//	console.log("-> ",get_date(),"RHEOS: WARNING   ⚠ RETRYING",player.name.toUpperCase(),"  BY FORCING TO START OF TRACK")
				//	services.svc_transport.seek(zone,'absolute',0)
			    //} 
				//if (zone?.state == "playing"){
				//	let res = await heos_command("player", "get_play_state",{pid : player.pid},5000,true)
				//	const { heos: { message: { parsed: {state } } } } = res
				//	if (state !== "play"){
				//		setTimeout(async () => {
						//	console.log("-> ",get_date(),"RHEOS: WARNING     ⚠",player.name.toUpperCase(),"FORCING PLAYER PLAY",zone.display_name)
						//	await heos_command("player", "set_play_state",{pid : player.pid, state : "play"},5000,true)
				//		},3000)
				//	}
				//}
		},5000)
	}
	})	 
	.on({ commandGroup: "event", command: "player_volume_changed" }, async (res) => {
		const { heos: { message: { parsed: { mute : state, level, pid } } } } = res
		const player = rheos_players.get(pid)
		if(player?.output){
			player.volume = {level,state} || {}
			if(player.type != "AVR"){
				if (player?.type != "AVR" && player?.volume?.level){
					services && level && services.svc_transport.change_volume(player?.output, 'absolute', level)	
				}
				if (player?.volume?.state){
					services && services.svc_transport.mute(player.output, (state== 'on' ? 'mute' : 'unmute'))	
				}
			} else {
				clearTimeout(player.avr_vol_delay)
				player.avr_vol_delay = setTimeout(()=> { 
					services.svc_transport.change_volume(player.output, 'absolute', level)	
					update_avr_status(player)
				},1000)
				
			}
		}	
	})
}
async function start_heos(counter = 0) {
	if (counter == 10){ process.exit(1)} 
	return new Promise (async function (resolve,reject){
		process.setMaxListeners(32)
		if (!rheos.connection) {
			console.log("-> ",get_date(),"RHEOS: DEFAULT   : HEOS CONNECTION IP IS",rheos.mysettings?.default_player_ip || "NOT SET")
			try {
				rheos.connection =   await Promise.all([HeosApi.connect(rheos.mysettings.default_player_ip),HeosApi.connect(rheos.mysettings.default_player_ip)]).catch((x)=> {throw x})
				console.log("-> ",get_date(),"RHEOS: CONNECTED : DEFAULT PLAYER IP",  rheos.mysettings.default_player_ip )	
			} catch {
				let discovered_player = await HeosApi.discoverOneDevice().catch((x)=> {console.log("-> ",get_date(),"RHEOS: DISCOVER  : NO PLAYERS FOUND"); throw x})
				
				if (!rheos.connection) rheos.connection =   await Promise.all([HeosApi.connect(discovered_player),HeosApi.connect(discovered_player)])
				console.log("-> ",get_date(),"RHEOS: CONNECTED : FIRST DISCOVERED PLAYER AT",discovered_player)
			} 	
		}
		rheos.connection[0].socket.setMaxListeners(32)
		rheos.connection[1].socket.setMaxListeners(32)
	    let players = await get_players() 
		for (let p of rheos.myplayers){
			let player = players.find(({pid}) => pid == p.pid)
			if (player){
				if (player?.ip && player.ip !== p.ip){
					console.log("-> ",get_date(),"RHEOS: WARNING : ⚠ NEW PLAYER IP", player.name.toUpperCase(),player.ip)
					p.ip = player.ip
					p.network = player.network
				} 
			player.resolution = p.resolution
			player.mode = p.mode
			}
		}
		rheos.myplayers = players
		rheos.myplayers.map(p => rheos_players.set(p.pid,p))
		players = rheos.myplayers.map((o) => {let {output,timeout,bridge,Z2,PWR,volume,zone,state,status,group,now_playing,position,duration,rheos,next,payload,force_play, ...p} = o;return(p)})
		const {payload} = await heos_command("group", "get_groups",10000,true).catch(err => console.error(get_date(),err))		
		for (const group of payload){
		   group.outputs = []
		   group.sum_group = sum_array(group.players.map(player => player.pid))
           rheos_groups.set(group.gid,group)
		}
		if (Array.isArray(players)&& players.length){
			await set_players(players).catch(()=>{console.error(get_date(),"RHEOS: ERROR  ⚠ SETTING PLAYERS")})
			let hb = 0
			rheos.heart_beat = setInterval (async () => {
				hb ++;
			   	if (roon?.paired){
					try {
						services.svc_transport.get_outputs(async (err,ops) =>{
							if (!err && ops){
								const old_ops = [...rheos_outputs.values()].map(o => o?.output_id)
								const all_ops = ops.outputs.map(o => o.output_id)
								const missing_op = all_ops.filter(({output}) => output && (!all_ops.includes(output) && old_ops.includes(output))).filter(o => {o})
								for (const op of missing_op){
									console.warn("-> ",get_date(),"RHEOS ⚠ OUTPUT   : RESETTING",op)
									const player = ([...rheos_players.values()].find(({output})=> output === op))
									let p = await heos_command("player", "get_player_info",{pid : player.pid},1000,true)
									if (!p){console.log(player?.name.toUpperCase(),"IS MISSING ON HEOS ")}
								}
							} else {
								console.warn("-> ",get_date(),"ROON ⚠ OUTPUTS   : NONE DETECTED")
								clearInterval(rheos.heart_beat)
								reject()
							}
						})
					} 
					catch {
						console.error ("ERROR CHECKING OUTPUTS PLEASE ENABLE THE RHEOS EXTENSION")
					}
				} else {
					console.error ("ROON NOT PAIRED")
				}
                hb = await monitor_status(hb)
			},10000)
			resolve	()
		} else {
			console.error("UNABLE TO DISCOVER PLAYERS",counter)
			counter ++
			reject(setTimeout(()=> {start_heos(counter)},10000))
		}	
	})
}
async function monitor_status(hb = 1){
				await heos_command("system", "heart_beat",10000,true).then (async (err)=>{
					if (err?.result == "success"){
							hb--
							update_status(false,false)
							
					} else {
						console.log("-> ",get_date(),"RHEOS: WARNING : ⚠ HEART BEAT FAILED",hb)
						if (hb >8) {
							clearInterval(rheos.heart_beat)
							await start_heos().catch((err) => {console.error(get_date(),"⚠ Error Restarting Heos",err);reject()})
						}
					}
				})
				return(hb)				
}
async function get_device_info(ip,name){
	if (!ip){ 
		console.log("NO IP",ip)
		return
	}
	try {
		console.log("-> ",get_date(),"RHEOS: DISCOVERED: GETTING INFO FOR", name,"@",ip)
		const response = await fetch('http://' + ip + ':60006/upnp/desc/aios_device/aios_device.xml').catch(err => console.error(err))
   		if (!response.ok) {	throw new Error(`Fetch failed: ${response.status}`)}
		const body = await response.text().catch(err => console.error(err))
		let re = new RegExp("<UDN>(.*?)</UDN?>")
		const upn = body.search(re)
		re = new RegExp("<lanMac>(.*?)</lanMac?>")
		const mac = body.search(re)
		return([body.slice(upn+5,upn+46),body.slice(mac+8,mac+25)])
	} catch(error) {console.error('Error fetching data:', error)}
}
async function reboot_heos_server(){
	let res = await heos_command("system", "reboot",20000)
	console.log("REBOOTING SYSTEM",res)	
}
async function delete_players(players){
	if (!Array.isArray(players)){return}
	const removed = []
	for (const p of players){
		let pid = p.pid
		if (rheos.processes[pid]?.pid){
			try{
			process.kill(rheos.processes[pid].pid,'SIGTERM')
			delete rheos.processes[pid]
			rheos_players.delete(pid)
			} catch {
				log && console.warn("-> ",get_date(),"RHEOS: WARNING   ⚠ Unable to kill",rheos_players.get(pid).name.toUpperCase())
			}
		}
	}
	players = rheos.myplayers.map((o) => {let {output,timeout,bridge,gid,Z2,PWR,volume,zone,state,status,group,now_playing,position,duration,rheos,next,payload,force_play, ...p} = o;return(p)})
    rheos.myplayers = players
	roon.save_config("players",players);
	return
}
async function set_players(players){
	if (!Array.isArray(players) || !players.length){return}
	//services.svc_transport.get_zones((err,data)=> {data.zones.flatMap(z => console.log(z.outputs.flatMap(o => o.source_controls)))})
	for await (const player of players) {
		log && console.log("-> ",get_date(),"RHEOS: SETTING   :",player.name," - ", player.model," - ",player.ip)
		if (player?.pid && typeof(player) === "object" ) {
			const p = rheos?.myplayers?.find(({pid}) => pid == player.pid)
			if (p){
				const {resolution = "",mode = "FLOW",auto_play,udn,ip} = p
				rheos.mysettings["P"+String((player.pid))] = (resolution ? resolution : player.model.includes("HEOS")? "CD" : "THRU")
				rheos.mysettings["M"+String((player.pid))] = mode
				rheos.mysettings["A"+String((player.pid))] = (auto_play || "OFF")
					if (!ip){
						console.warn(get_date(),player.name.toUpperCase(),"Unable to get player ip")
						let p = await heos_command("player", "get_player_info",{pid : player.pid},1000,true)
							if (p?.payload?.ip){
								player.ip =p ?.payload?.ip
							} else {continue}
					}
					if (!udn){
						if (player.ip){
							const info = await get_device_info(player.ip,player.name).catch(()=>{console.error(get_date(),"Unable to get player UDN",player.name)})
							if (info?.length == 2){
								player.udn = (info[0])
								player.mac = (info[1])
							} 
						} else {
							continue
						}
					}
				player.resolution = ((resolution ? resolution : player.model.includes("HEOS")? "CD" : "THRU"))
				player.mode =  (mode ? mode : "FLOW")
				
				await create_player(player).catch(()=>{console.error(get_date(),"Failed to create player",player)})
			}
		}
	}	
	players = [...rheos_players.values()].map((o) => {let {timeout,bridge,gid,Z2,PWR,volume,zone,state,status,group,now_playing,position,duration,rheos,next,payload,force_play, ...p} = o;return(p)})
    rheos.myplayers = players
	roon.save_config("players",players);
	console.table([...rheos_players.values()], ["name", "pid", "model","udn", "ip", "resolution","network","mode"]) 
	return
}
async function get_players() {
	return new Promise(function (resolve, reject) {
		if (!rheos.connection) {reject("AWAITING CONNECTION")}
		rheos.connection[1]
		.write("player", "get_players", {})
		.once({ commandGroup: 'player', command: 'get_players' }, async(players) => {
			switch(true){
				case (players?.payload?.length > 0 && players?.payload.every((p)=> p?.pid)) : {
					const changed = players.payload.length - rheos.myplayers.length
					changed && log && console.log("-> ",get_date(),"RHEOS: CHANGED   :",changed, "PLAYERS")
					resolve(players?.payload)
				}	
				break
				case (players.heos.result === "failed"):{ 
					log && console.warn("-> ",get_date(),"RHEOS: WARNING  ⚠ UNABLE TO GET PLAYERS")
					console.error(get_date(),"",players)
					reject()
				}			
				break
				case (players?.heos.message.unparsed == "command under process"):{
				    await delay(2000,"UNDER PROCESS")
					rheos.connection[1]
					.write("player", "get_players", {})
					.once({ commandGroup: 'player', command: 'get_players' }, (players) => {
						if (players?.payload?.length > 0 && players?.payload.every((p)=> p?.pid)) {
							log && console.log("-> ",get_date(),"RHEOS: IDENTIFIED :",players.payload.length, "RHEOS PLAYERS")
							resolve(players?.payload)
						} else {
							reject("⚠  ERROR GETTING PLAYERS")
						}
					})
				} 
				break
				case (players?.payload?.length > 16) : {
					console.error("⚠ LIMIT OF 16  HEOS PLAYERS EXCEEDED ",players?.payload?.length)
					reject()
				}
				break
				default : {
					console.error(get_date(),"DEFAULT UNABLE TO GET PLAYERS",players)
					reject()	
				} 
			}
		})
	})
}
async function create_player(player) { 
	const file = './UPnP/Logs/' + player.name.trim() + '.log';
	const content = 'RHEOS * \n';
	log && console.log("-> ",get_date(),"RHEOS: WRITING   :",player.name.toUpperCase(),file)
	await fs.writeFile(file, content);
	try { 
		let p = rheos.processes[player.pid.toString()]
		try{
			if (p?.pid && rheos.processes[player.pid]){
				rheos.processes[player.pid] && delete(rheos.processes[player.pid])
			    p?.pid &&	process.kill(p.pid,'SIGTERM'); 
			}
		} catch{
			console.error("-> ",get_date(),"RHEOS: ERROR    ⚠ KILLING",player.name)
		}		
		await set_player_resolution(player).catch(err =>{console.log(err)})	
		
		if(player.name) {rheos.processes[player.pid] =  spawn(
			app,
			['-b', rheos.system_info[0], 
			'-Z',
			'-M', player.name.trim().toUpperCase()+" (RHEOS: "+player.model+")",
			'-x', './UPnP/Profiles/' + player.name.trim() + '.xml',
			'-P',																																																																																																																																																																																																																											
			'-f','./UPnP/Logs/' + player.name.trim() + '.log',
			'-d','all=info',
			'-s',rheos.mysettings.host_ip || null
			],{ stdio: ['pipe',process.stderr,'pipe'] }
		)}			
	} catch (player) {
		log && console.warn("-> ",get_date(),"RHEOS: WARNING   ⚠ UNABLE TO CREATE PLAYER",player?.name)
	}
	rheos.processes[player.pid].on('uncaughtExceptionMonitor', async (err,origin) => {	
		console.error("-> ",get_date(),"RHEOS: EXCEPTION    :",player.name.toUpperCase(),err,origin)
	})
	rheos.processes[player.pid].on('exit',  async () => {	
		log && console.log("-> ",get_date(),"RHEOS: EXIT      :",player.name.toUpperCase()," - ",rheos_players.get(player.pid)?.output || "not activated"," ".repeat(100))
	})
	rheos.processes[player.pid].on('spawn', async () => {
		log && console.log("-> ",get_date(),"RHEOS: CREATED   :",player.name.toUpperCase())
		const rheosTail = new tailfile("./UPnP/Logs/"+player.name.trim()+".log", async line => {
			if (line.includes("set current URI")){
				const bridge = sliceStringFromValue(line,"http")
				const p = rheos_players.get(player.pid)
				if (p?.is_leader && p?.is_leader() && p?.payload?.mid == '1'){		
					clearTimeout(p.timeout)
					p.timeout = setTimeout(async ()=>{	
						const zone = services.svc_transport.zone_by_zone_id(p.zone)
						if (zone?.is_play_allowed){
							await services.svc_transport.control(zone,'play')
						}
						let player = rheos_players.get(p.pid);
					    console.log("-> ",get_date(),"RHEOS: BRIDGED   :",player.mode.toUpperCase(),(rheos_groups.get(player.pid)?.name || player.name || "x").toUpperCase(),p?.now_playing?.one_line?.line1||zone?.now_playing?.one_line?.line1 || "NONE",bridge)
					},1000)	
				}	
			   return (rheos.processes[player.pid])
			}
		})
	}) 	
}
function sliceStringFromValue(str, value) {
	const index = str.indexOf(value);
	if (index === -1) {
	  return "Value not found in string";
	}
	return str.slice(index);
}
async function load_fixed_groups(){
	for await (let group of rheos.myfixed_groups){	
		create_fixed_group(group).catch(()=> {})

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
async function create_fixed_group(group,op){
	log && console.log("-> ",get_date(),"RHEOS: CREATING  : FIXED GROUP",group.name,group.resolution)
	const fixed = Math.abs(group.sum_group).toString(16);
	group.display_name = "🔗 " + group.name
	if (!rheos.processes[fixed]){	
		const mac = "bb:bb:bb:"+ fixed.replace(/..\B/g, '$&:').slice(1,7)
		log && console.log("-> ",get_date(),"RHEOS: SPAWNING  : FIXED GROUP",group.display_name,mac,fixed)
		rheos.processes[fixed] = spawn(squeezelite,[
			"-M",group.display_name,
			"-m",mac,
			"-r",group.resolution || 48000,
			"-o", '-',
			'-s',  rheos.mysettings.host_ip,
			'-f','./UPnP/Logs/' + group.display_name + '.log'])
	}
	return
}
async function set_fixed_group(group){
		group.is_grouped = false
		group.status = "stopped"
		delete(group.now_playing)
		delete(group.waiting)
		delete(group.status)
		fixed_groups.set(group.sum_group,group)
		rheos.mysettings[group.sum_group.toString()]=[group.resolution]
		rheos.myfixed_groups = [...fixed_groups.values()]
		roon.save_config("fixed_groups", rheos.myfixed_groups)
}
async function create_fixed_group_control(){
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

			log && console.log("STANDING BY FIXED GROUP")
			req.send_complete("Success")				 
		}
	}
	Object.keys(rheos.fixed_group_control).length === 0 && (rheos.fixed_group_control = services.svc_source_control.new_device(controller))
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
		console.error("-> RHEOS: UNABLE TO FIND FIXED GROUP",sum_group)
	}
   	return 
}
async function start_roon(restart) {
	log && console.log("-> ",get_date(),"RHEOS: SYSTEM    :",restart ? "RESTARTING":"STARTING","RHEOS")
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
	if (!restart && rheos.mysettings.fixed_control){
		let  g = roon.load_config("fixed_groups") || []
		rheos.myfixed_groups = g
		Array.isArray (rheos.myfixed_groups)  &&   rheos.myfixed_groups?.forEach(g => {
			fixed_groups.set(g.sum_group,g)
		})			
		if (restart){
			await load_fixed_groups()
		}
	}
	services.svc_settings = new RoonApiSettings(roon, {
		get_settings: async function (cb) {
			Array.isArray(rheos.myplayers) && rheos.myplayers.forEach(p => {
				if (p?.model && !p.resolution){p.resolution =  p.model.includes("HEOS")? "CD": "THRU"}
			 	rheos.mysettings["P"+String(p.pid)] = p.resolution 
				rheos.mysettings["M"+String(p.pid)] = (p.mode || "FLOW")
				rheos.mysettings["A"+String(p.pid)] = (p.auto_play || "OFF")
			})
			await get_all_groups()
			Array.isArray(rheos.myfixed_groups) && rheos.myfixed_groups.forEach(g => {rheos.mysettings[g.sum_group] = (g.resolution)})
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
							let p = rheos_players.get(player.pid)
							p.auto_play = player.auto_play
						}
					}		
				}
				let players = rheos.myplayers.map((o) => {let {output,timeout,bridge,gid,Z2,PWR,volume,zone,state,status,group,now_playing,position,duration,rheos,next,payload,force_play, ...p} = o;return(p)})
			    rheos.myplayers = players		
				for await (const group of all_groups){
					group[1].resolution = settings.values[group[1].sum_group] 
					if (settings.values[group[0]] >-1 ){
						group[1].now_playing = null
						group[1].waiting = null
						create_fixed_group(group[1])
						set_fixed_group(group[1])
					} else {	
						remove_fixed_group(group[0],true)
					}
				}
				if (settings.values.fixed_control){
					await load_fixed_groups().catch(err => console.error(get_date(),"⚠ Error Loading Fixed Groups",(err) => {throw error(err),reject()}))
				} else {
				  	await unload_fixed_groups().catch(err => console.error(get_date(),"⚠ Error Unloading Fixed Groups",(err) => {throw error(err),reject()}))
				}
				if (settings.values.avr_control){ 
					if (settings.values.avr_control !== rheos.mysettings.avr_control){
						await create_zone_controls().catch( err => {console.error(get_date(),"⚠ Error Creating Zone Controls",err);reject()})
					}
					let avrs = [...rheos_players.values()].filter(player => player.type == "AVR")
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
					log = changed.log
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
		required_services: [RoonApiTransport], provided_services: [	services.svc_status,	services.svc_settings, services.svc_source_control,services.svc_volume_control], 
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
				log && console.error ("ALREADY BUFFERED",ip,command)
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
	for (const player of [...rheos_players.values()]){
		if (player.model && (!player.model.includes("HEOS"))&&(!player.model.includes("Home"))&& (!player.model.includes ("MODEL")) ){
			log && console.log("<- ",get_date(),"AVR  : TESTING   :",player.name)
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
			roon.paired || log && process.stdout.write(get_date()+ (" UNPAIRED\r"))
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
									log && console.log("-> ",get_date(),"AVR  : SOUND MODE:",avr?.name.toUpperCase(),(MV))
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
								log && console.log("-> ",get_date(),"AVR  : UNMUTE",index === 0?  avr?.name + "​ Main​ Zone": avr?.name + "​ Zone​ 2")
								services.svc_transport.mute(op,'mute')
							} else if (s.has("Z2MUOFF" && op.volume.is_muted)){
								log && console.log("-> ",get_date(),"AVR  : SET MUTE",index === 0?  avr?.name + "​ Main​ Zone": avr?.name + "​ Zone​ 2")
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
	log && console.log("-> ",get_date(),"AVR  : ZONE ON   :",index === 0?  avr?.name + "​ Main​ Zone": avr?.name + "​ Zone​ 2")
	const hex = ((Math.abs(avr?.pid)+(index+1)).toString(16))
	if (! rheos.processes[hex]){
		const mac = "bb:bb:"+ hex.replace(/..\B/g, '$&:').slice(-11)
		rheos.processes[hex] = spawn(squeezelite,["-M", index === 0?  avr?.name + "​ Main​ Zone": avr?.name + "​ Zone​ 2","-m", mac,"-o","-","-Z","192000"])
	} else {
		log && console.warn("-> ",get_date(),"RHEOS: WARNING   ⚠ AVR ZONE ALREADY EXITS",rheos.processes[hex].spawnargs[2])
	}
}
async function create_avr_controls(player){	
	player = rheos_players.get(player.pid)
		for (let index = 1; index < 3; index++) {
			switch (index) {
				case 1 :
					log && console.log("-> ",get_date(),"RHEOS: CREATING  : AVR CONTROL",  player?.name +  "​ Main​ Zone")
				break
				case 2 :
					log && console.log("-> ",get_date(),"RHEOS: CREATING  : AVR CONTROL",  player?.name + "​ Zone​ 2")
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
							log && console.log("SELECT CONVENIENCE SWITCH",this.state.display_name)
						}
						req.send_complete("Success")						
					},  
					standby:  async function (req) {
					    avr_zone_controls[(Math.abs(player.pid)+index).toString()].update_state({ status : "indeterminate"})
						avr_zone_controls[(Math.abs(player.pid)+index).toString()].state.status = "standby"
						rheos.block_avr_update = true
						await control_avr( this.state.ip,this.state.index == 1 ?  "ZMON" : "Z2ON" ).catch(()=>{console.error("⚠ ERROR SETTING AVR POWER")})
						await control_avr( this.state.ip,this.state.index == 1 ?  "SINET" : "Z2NET" ).catch(()=>{console.error("⚠ ERROR SETTING AVR TO NETWORK")})
						await update_avr_status(rheos_players.get(this.state.pid),"standby").catch(()=>{console.error("⚠ ERROR UPDATING AVR STATUS")})
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
		log && console.log("-> ",get_date(),"RHEOS: CREATING  : CUSTOM VOLUME CONTROLLER",player.name.toUpperCase())
		avr_volume_controls[player.pid] || (avr_volume_controls[player.pid] = services.svc_volume_control.new_device(volume_control))	
}
async function update_control (state){
	const{name,ip,pid}=state
	const player = rheos_players.get(pid)
	log && console.log("-> ",get_date(),"RHEOS: UPDATING  : AVR SOUND MODE",player.name.toUpperCase())
    let present = [...player.status].find((o)=> o.includes("MS"))
	let present_mode_index = sound_modes.findIndex((sm) => sm == present)
	let next = (present_mode_index < sound_modes.length-1 ? sound_modes.at(present_mode_index+1): sound_modes.at(0))
	log && console.log("-> ",get_date(),"RHEOS: UPDATING  : AVR SOUND MODE",player.name.toUpperCase(),"from",present,"to",next)
	await control_avr( ip, next).catch(()=>{console.error("⚠  ERROR UPDATING SOUND MODE ",name,ip,next)})
    await update_avr_status(rheos_players.get(pid))
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
		outputs.map(async (op )=> {
			log && console.log("<- ",get_date(),"RHEOS: REMOVED",rheos_outputs.get(op)?.display_name || "AVR ZONE?")
			let o = rheos_outputs.get(op)
			if(o){
				const player = ([...rheos_players.values()].find(({output})=> output === op))
				if (player){
					log && console.log("<- ",get_date(),"RHEOS: CHECKING  :", player.name.toUpperCase(),"IS STILL A ON LINE")
					let p = await heos_command("player", "get_player_info",{pid : player.pid},1000,true)
					if (p){
						console.log("PLAYER IS STILL ALIVE ON HEOS ")
						create_player(player)
						restart_zones()
					}
				}
			}										
		})
		return
	}
	let player = {}
	return new Promise(async function (resolve) {
	for await (const op of outputs) {	
		if(Array.isArray(op?.source_controls)){
			const {display_name} = op?.source_controls[0]
			if (display_name.includes("RHEOS")   ||  display_name.includes ("🔗")){
				log && console.log("<- ",get_date(),"RHEOS: OUTPUT    :",cmd.toUpperCase(),display_name)
				player =  [...rheos_players.values()].find(({name}) => display_name.includes(name.trim().toUpperCase()+ " (RHEOS"))
				if (player){
					player.zone = op.zone_id
					player.output = op.output_id
				} 
				const old_op = rheos_outputs.get(op.output_id) 
				const diff = op.volume?.value - old_op?.volume?.value ?? op.volume?.value	
				rheos_outputs.set(op.output_id,op)
				if  (old_op?.volume) {old_op.volume.value = op.volume?.value}
				const fixed_group = [...fixed_groups.values()].find(g => g.display_name == op.source_controls[0].display_name )
				if ( display_name.includes ("🔗")  && fixed_group){
					if (diff || !old_op?.volume || op?.volume?.is_muted != old_op?.volume?.is_muted){	
						for (let p of fixed_group?.players){
							let player = rheos_players.get(p.pid)
							const output= rheos_outputs.get(player?.output)
							if (output?.volume){
								output.volume.value = (output.volume.value + diff)
								output.volume.is_muted = op?.volume?.is_muted
								if (!output.volume?.value || output.volume.level <0){
									output.volume.level = 0
								}
								update_player_volume(output,player)	
							}
						}										
					}
				}	
				if (player?.type == "AVR" &&  diff !== 0){
					await update_player_volume(op,player)
				} 
			} else if (display_name.includes("​")) {
				log && console.log("<- ",get_date(),"RHEOS: AVR OUTPUT:",cmd.toUpperCase(),display_name,op.volume.value)
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
		if (player?.pid && player.type !== "AVR" && cmd !== "avr"){
			await update_player_volume(op,player)
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
				zone_ready.emit("ZONE",z.zone_id,z.is_play_allowed,z.outputs[0].output_id,z.outputs.length)
				const old_zone = rheos_zones.get(z.zone_id)
			    rheos_zones.set(z.zone_id,z)
				const player = [...rheos_players.values()].find ((o) => o.output === z.outputs[0]?.output_id)
				const fixed = (z.outputs[z.outputs.length-1].source_controls[0].display_name.includes("🔗")) ? [...fixed_groups.values()].find((o) => o.display_name == z.outputs[z.outputs.length-1].source_controls[0].display_name):false
				if (!fixed && z.outputs.length == 1){		
					if (player?.payload && player.payload.mid =='1' && player?.is_leader && player?.is_leader()){
						player.zone = z.zone_id
						if (z.state == "paused" && old_zone && old_zone?.state !== "paused" && old_zone?.state !== "stopped"){
							log && console.log("<- ",get_date(),"RHEOS: STOPPING  :", (player.gid && rheos_groups.get(player.gid)) ? "GROUP".padEnd(10," ")+"- "+rheos_groups.get(player.gid)?.name: "PLAYER".padEnd(10," ")+"- "+player.name.toUpperCase(),player.mode,player.state,z.now_playing?.three_line.line1 || "NOTHING PLAYING")		
							await heos_command("player", "set_play_state",{pid : player.pid, state : "stop"},10000,true)
						}
						if ((z.state == 'loading')  ){
							player.now_playing = z.now_playing
							await write_meta(player,player.mode)		
						}					
					} else if(player?.state == "play" &&player?.payload && player.payload?.mid !== "1" && player.is_leader && player?.is_leader()){
						if (z.state == "playing" ){
							log && console.log("<- ",get_date(),"RHEOS: STOPPING  : NON RHEOS STREAM STARTED PLAYING ON HEOS PLAYER",z.display_name,z.now_playing?.one_line?.line1)
							await control_zone(player.zone,"stop")
						} 	
					}  
				}	
                if (fixed){	
					if(added){
						fixed.control_display_name = z.display_name
						fixed.control_zone = z.zone_id
						roon.save_config("fixed_groups",rheos.myfixed_groups)
					}
					if ((z.outputs.length == 1) && (z.state == 'playing' )){
						log && console.log("-> ",get_date(),"RHEOS: SETTING   : FIXED GROUP",JSON.stringify(fixed?.name),fixed.players.map(({pid}) => pid))
						const outputs = []
						const max_vol = 40
						const is_muted = z.outputs[0].volume.is_muted
						fixed.sum_group = 0
						delete(fixed.now_playing)
						for (let p of fixed.players){
							let player = rheos_players.get(p.pid)
							
							if (player?.output ) {
				
								outputs.push(player.output)
								fixed.sum_group = fixed.sum_group + player.pid
								log && console.log("-> ",get_date(),"RHEOS: FIXED MUTE:",player.name.toUpperCase(), is_muted ? "ON" :"OFF")
								update_player_volume(player.output,player)
								services.svc_transport.mute([player.output],is_muted ? "mute" : "unmute")
							} 
						}
						rheos_outputs.get(z.outputs[0].output_id).volume.value &&= max_vol
						services.svc_transport.change_volume(z.outputs[0],"absolute",max_vol)
						outputs.push(z.outputs[0].output_id)
						fixed.outputs = outputs
						if (z && fixed.sum_group && !fixed.waiting ){						
							log && console.log("-> ",get_date(),"RHEOS: TRANSFER  :",z.display_name.toUpperCase(), "to",rheos_outputs.get(outputs[0]).display_name)
							fixed.waiting = z.now_playing
							fixed.now_playing = null
							services.svc_transport.transfer_zone( z,outputs[0],	async (err) => { 
								if (err){
									console.error("-> ",get_date(),"RHEOS: TRANSFER  ⚠ ERROR - unable to detect destination",rheos_outputs.get(outputs[0]).display_name)
								} 	
							})
						}
						if (fixed?.waiting && fixed.waiting?.one_line.line1 == z.now_playing?.one_line.line1){
							log && console.log("-> ",get_date(),"RHEOS: GROUPING  : FIXED",fixed.name)
							services.svc_transport.group_outputs(outputs, async()=>{await start_fixed_group(fixed).catch((err) => console.log(err))})  
							fixed.waiting = null 	
						}	
					} 
					else if (fixed.sum_group == get_zone_group_value(z) && z.state == 'playing'){
						log && console.log("-> ",get_date(),"RHEOS: PLAYING   : FIXED",z.display_name.toUpperCase())
						fixed.now_playing = z.now_playing
						fixed.waiting = null
					}
					else if (fixed.sum_group == get_zone_group_value(z) && z.state == "paused" && fixed.now_playing != null){
						log && console.log("-> ",get_date(),"RHEOS: PAUSED    : FIXED",z.display_name.toUpperCase())
					    fixed.now_playing = null
						services.svc_transport.ungroup_outputs(z.outputs)
						
					}
					else if(z.display_name !== fixed.control_display_name){
						fixed.control_display_name = z.display_name
					}
					resolve()
				}
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
						log && console.log("-> ",get_date(),"AVR  : STANDBY ZONE",z.outputs[index].source_controls[0]?.display_name)
						services.svc_transport.ungroup_outputs([z.outputs[index]]);
						const control  = Object.entries(avr_zone_controls).find(o=> o[1].state.display_name == get_output_name(z.outputs[index])	)	
						if (control){
							let {state : {pid,ip,index}} = control[1]	
							let avr_status = rheos_players.get(pid).status
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
						else if (status === "standby" && rheos_players.get(pid)){
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
				let new_rheos_outputs = z.outputs.filter((o)=> o.source_controls[0].display_name.includes("RHEOS"))
				let old_rheos_outputs = []
				if (old_zone) {old_rheos_outputs = old_zone.outputs.filter((o)=> o.source_controls[0].display_name.includes("RHEOS"))}
				if ( new_rheos_outputs.length && (new_rheos_outputs.length == 1 || !old_zone || (old_rheos_outputs.length !== new_rheos_outputs.length) || (JSON.stringify(new_rheos_outputs.map(o => o.output_id)) !== JSON.stringify(old_rheos_outputs.map(o => o.output_id))))){        
					const {payload} = await heos_command("group","get_groups",10000,true).catch(err => console.error(get_date(),err))
					const new_roon_group = [...new Set(new_rheos_outputs.map(output => get_pid_by_op(output.output_id)).filter(o => o))]
					if (new_roon_group.length >1 && (!payload || !payload.length  || !(payload).map(o => sum_array(o.players.map(player => player.pid))).includes(sum_array(new_roon_group)))){	
						log && console.log("-> ",get_date(),"RHEOS: ZONE      : GROUPING",new_roon_group,z.state)
						await group_enqueue(new_roon_group).catch(()=>{console.log("ALREADY GROUPING",new_roon_group)})
					} else if (new_roon_group.length == 1 && payload && payload.find(({gid}) => gid == new_roon_group[0])){
						log && console.log("-> ",get_date(),"RHEOS: ZONE      : UNGROUPING",new_roon_group,z.state)
						await group_enqueue(new_roon_group).catch(()=>{console.log("ALREADY DELETING",new_roon_group)})
					} 
				}		
			} 
		}
		resolve()
	}).catch(err => console.error("-> ",get_date(),"RHEOS: ZONE    ⚠ ERROR UPDATING ZONES",err))	
}
async function start_fixed_group(fixed){	
	log && console.log("-> ",get_date(),"HEOS : WAITING ON:",fixed?.name.toUpperCase())
	let counter = 0
	const promise = new Promise (async function (resolve,reject){
		const timeout = setTimeout(()=> {
			reject("TIMED OUT")
		},20000)
		const check = async function(counter){
		await update_heos_groups()	
			const group = [...rheos_groups.values()].find(({sum_group}) => sum_group == fixed.sum_group)		
			if (group ){	
				const output = rheos_outputs.get(fixed.outputs[fixed.outputs.length -1])	
				const zone = services.svc_transport.zone_by_output_id(fixed.outputs[0])
				if (zone.outputs.length == fixed.outputs.length){
					await heos_command("group", "set_mute", { gid: group.gid, state: output.volume.is_muted ? "on": "off"},1000,true).catch(err => console.error(get_date(),err))
					if (zone.is_play_allowed){
						log && console.log("-> ",get_date(),"RHEOS: READY     :",fixed?.name.toUpperCase())
						services.svc_transport.control(zone,'play',
							(err)=> {if (err){
							console.error(err)
								check(counter ++)
							} else {
								clearTimeout(timeout)
								resolve(true)
							}
						})	
					} else if (zone.state == "loading"){
						log && console.log("-> ",get_date(),"RHEOS: READY SOON:",fixed?.name.toUpperCase())
						clearTimeout(timeout)
						resolve(true)
					} else if (zone.state == "playing"){
						log && console.log("-> ",get_date(),"RHEOS: READY NOW:",fixed?.name.toUpperCase())
						clearTimeout(timeout)
						resolve(true)
					} else  {
						console.log(counter)
						await delay(2000)
						check(counter ++)
					}
				} else {
					services.svc_transport.group_outputs(fixed.outputs,(err)=>{
						err ? console.log(err) :
						log && console.log("-> ",get_date(),"RHEOS: ADDING :",fixed)
					})
							
				}
			} else {
				try {
					await update_heos_groups()
					setTimeout(async ()=> {
						const group_now = [...rheos_groups.values()].find(({sum_group}) => sum_group == fixed.sum_group)
						if (!group_now){
							services.svc_transport.group_outputs(fixed.outputs,(err)=>{
								err ? 
								log && console.error("-> ",get_date(),"RHEOS: WARNING :","ERROR GROUPING",err,fixed?.name.toUpperCase())
								:
								log && console.log("-> ",get_date(),"RHEOS: RETRYING :","GROUPING",fixed?.name.toUpperCase())
							})
						}
					},3000)
				} catch {
					log && console.error("-> ",get_date(),"RHEOS: FAILED :","GROUPING",fixed?.name.toUpperCase())
				}
				await delay(1000)
				check(counter ++)	
			}	
		}		
			check(counter ++)
		})
	return promise
}
async function write_meta(player,why){
	if (player?.now_playing && player?.udn){	
 		const now_playing = player.now_playing 
		const duration = (player.now_playing?.length - player.now_playing?.seek_position) * 1000
		const position = ((player?.now_playing?.seek_position || 1) *1000 )
		log && console.log("<- ",get_date(),"RHEOS: META",why.padEnd(7 - why.length," "),":",player.name.toUpperCase(),"♫",player.now_playing?.one_line?.line1,duration,position)
	    await fs.writeFile(
			"./UPnP/"+player.udn,
			(player.mode == "FLOW" || player.mode == "ALBUM" ? "Streaming from RHEOS" : now_playing?.three_line?.line1) + "\n" 
			+ (player.mode == "FLOW" ? "FLOW MODE ON" : (now_playing?.three_line?.line2 )) + "\n" 
			+ ((player.mode == "FLOW" || player.mode == "ALBUM") ?  (rheos_groups.get(player.pid)?.name || player.name) : ("RHEOS: " +  now_playing?.three_line?.line3))   + "\n"
			+ duration.toString() + "\n" 
			+ position.toString() + "\n" 
			+ (player.mode == "ART" || player.mode == "ALBUM"  ? (now_playing?.image_key) : `http://${rheos.system_info[0]}:${image_server.address().port}/Images/${rheos.mysettings.logo}`), 
			{encoding: "utf8",	flag: "w",	mode: 0o666 }
		)	
	} 
	return
}
async function update_player_volume(op,player){
    const{is_muted,value} = op?.volume || {}
	const{name,pid,volume,volume:{level} = {} } = player ||  {}
	if (!player?.name) return
	if (player?.volume?.level !== value){
		player.volume = {level : value, state: is_muted ? "on": "off"}
		log && console.log("<- ",get_date(),"RHEOS:",volume ?"UPDATING  :" : "SETTING   :",name.toUpperCase(),"VOLUME",value, volume ? "FROM" : "",level || "")	
		await heos_command("player", "set_volume", { pid: pid, level: value > 0 ? value  : 0 },200,true).catch(err => console.error(get_date(),err))	
	}
	if (player?.volume?.state  !== (is_muted ? "on" : "off")){
		player.volume = {level : value, state: is_muted ? "on": "off"}
		log && console.log("<- ",get_date(),"RHEOS:",volume ?"UPDATING  :" : "SETTING   :",player.name.toUpperCase(),"MUTE",(is_muted?"ON":"OFF"))
		await heos_command("player", "set_mute", { pid: pid, state: is_muted ? "on": "off"},1000,true).catch(err => console.error(get_date(),err))
	}
	return
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
async function heos_command(commandGroup, command, attributes = {}, timer = 5000, hidden = false) {	
	if (!rheos.connection) {
		log && console.warn("-> ",get_date(),"RHEOS: WARNING   ⚠ NO CONNECTION FOUND - RESTARTING RHEOS")
		start_up(true)
		return
	}
	typeof attributes === "object" || ((timer = attributes), (attributes = {}),(hidden = timer))
	!hidden && log && console.log("-> ",get_date(),"HEOS : REQUEST   :",commandGroup.toUpperCase(), command.toUpperCase(), attributes)
	return new Promise(async function (resolve, reject) {
		setTimeout(() => {resolve(`Heos command timed out: ${command} ${timer}`) }, timer)
		commandGroup !== "event" && rheos.connection[0].write(commandGroup, command, attributes)
		rheos.connection[0].once({ commandGroup: commandGroup, command: command, attributes }, async (res) => {
			res.parsed = res.heos.message.parsed
			res.result = res.heos.result
			if (res.heos.message.unparsed.includes("under process") ) {	
				rheos.connection[0].once({ commandGroup: commandGroup, command: command, attributes }, async (res) => {
				resolve(res)
			})} 
			else if (res.heos.message.unparsed.includes("unknown")) {
				await delay(1000,"UNKOWN")
				commandGroup !== "event" && rheos.connection[0].write(commandGroup, command, attributes)
				rheos.connection[0].once({ commandGroup: commandGroup, command: command, attributes }, (res) => {
					!hidden && log && console.log("<- ",get_date(),"RHEOS: COMPLETE  :",res.heos.message.parsed && (JSON.stringify(res.heos.message.parsed || res.heos.message.unparsed)),res.payload || "")
					resolve(res)
				})
			} 
			else if (res.heos.message.unparsed.includes("Processing previous command")) {
				await delay (1000)
				console.log(res)
				rheos.connection[0].once({ commandGroup: commandGroup, command: command, attributes }, async (res) => {
				resolve(res)
				})
			} 
			else if (res.heos.message.unparsed.includes("Command not executed")) {
				resolve(res)
			}
			else if (res.heos.result === "success") {
				!hidden && log && console.log("<- ",get_date(),"RHEOS: COMPLETE  :",res.heos.message.parsed && (JSON.stringify(res.heos.message.parsed || res.heos.message.unparsed)),res.payload || "")
				resolve(res)
			}
			else {
				console.error(res)
				reject(res)	
			}		
		})
	}).catch((err)=> {
		const {command,parsed} = err.heos
		log && console.warn("-> ",get_date(),"HEOS : WARNING   ⚠ COMMAND ERROR",command,parsed)
	})
}
async function set_player_resolution(player){
	log && console.log("-> ",get_date(),"RHEOS: SETTING   : PLAYER RESOLUTION",player.name.toUpperCase())
	let device = {} 
	device.udn = player.udn || player.gid
	device.friendly_name = player.name 
	switch (player.resolution) {
		case  ( "HR") :{
			device.enabled = '1'
			device.mode = ("flc:0,r:-192000,s:24").toString().concat(rheos.mysettings.flow ? ",flow" : "")
			device.sample_rate = '192000'	
		} 
		break
		case  ( "THRU" ) : {
			device.enabled = '1'
			device.mode = ("thru")
			device.sample_rate = '192000'
		}
		break
		case  ( "LOW" ) : {
			device.enabled = '1'
			device.mode = ("thru")
			device.sample_rate = '48000'
		}
		break
		default : {
			device.enabled = '1'
			device.mode = ("flc:0,r:-48000,s:16").toString().concat(rheos?.mysettings?.flow ? ",flow" : "")
			device.sample_rate = '48000'
		}
	}
	switch (player.mode) {
		case  ( "OFF") :{
			device.flow  = "0"
			device.send_metadata = "0"
			device.send_coverart = "0"
		} 
		break
		case  ( "META" ) : {
			device.flow  = "0"
			device.send_metadata = "1"
			device.send_coverart = "1"
		}
		break
		case  ( "ART" ) : {
			device.flow  = "0"
			device.send_metadata = "1"
			device.send_coverart = "1"
		}
		break
		default : {
			device.flow  = "0"
			device.send_metadata = "1"
			device.send_coverart = "1"
		}
	}
	const template = 	
		`<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
		<squeeze2upnp>
		<common>
			<enabled>0</enabled>
			<roon_mode>1</roon_mode>
			<codecs>aac,ogg,flc,alc,pcm,mp3</codecs>
			<forced_mimetypes>audio/mpeg,audio/vnd.dlna.adts,audio/mp4,audio/x-ms-wma,application/ogg,audio/x-flac</forced_mimetypes>
			<raw_audio_format>raw,wav,aif</raw_audio_format>
	        <volume_on_play>${rheos.mysettings.volume_on_play}</volume_on_play>
		</common>
		<device>
		    <udn>${player.udn}</udn>
			<enabled>1</enabled>
			<friendly_name>${device.friendly_name}</friendly_name>
			<L24_format>2</L24_format>
			<sample_rate>${device.sample_rate}</sample_rate>
		    <send_metadata>${device.send_metadata}</send_metadata>
			<send_icy>0</send_icy>
		    <send_coverart>${device.send_coverart}</send_coverart>
		    <flow>${device.flow}</flow>
		    <mode>${device.mode}</mode>
			</device>
		</squeeze2upnp>`
	await fs.writeFile("./UPnP/Profiles/" + (player.name.trim()) + ".xml", template).catch(()=>{console.error(get_date(),"⚠ Failed to create template for "+device.name[0])})
	const saved_player = rheos.myplayers.find(({pid}) => pid == player.pid)
	if (saved_player){
		saved_player.resolution = player.resolution
		saved_player.mode = player.mode
	}
	player.is_leader = function(){return Boolean(!this.gid || this.pid === this.gid)}
	rheos_players.set(player.pid,player)
}	
async function start_listening() {
	await heos_command("system", "prettify_json_response", { enable: "on" },true).catch(err => console.error(get_date(),"⚠ Failed to set responses"))
}
async function choose_binary(fixed = false) {
	if (os.platform() == 'linux') {
		try {
			if (os.arch() === 'arm'){
				await fs.chmod(fixed ? './UPnP/Bin/squeezelite/squeezelite-armv6hf':'./UPnP/Bin/RHEOS-armv6', 0o555)
				return (fixed ? './UPnP/Bin/squeezelite/squeezelite-armv6hf' :'./UPnP/Bin/RHEOS-armv6')
			} else if (os.arch() === 'arm64'){
				await fs.chmod(fixed ? './UPnP/Bin/squeezelite/squeezelite-arm64':'./UPnP/Bin/RHEOS-arm', 0o555)
				return(fixed ? './UPnP/Bin/squeezelite/squeezelite-armv64':'./UPnP/Bin/RHEOS-arm') 
			} else if (os.arch() === 'x64'){ 
				await fs.chmod(fixed ? './UPnP/Bin/squeezelite/squeezelite-x86-64':'./UPnP/Bin/squeeze2upnp-linux-x86_64-static', 0o555)
				return(fixed ? './UPnP/Bin/squeezelite/squeezelite-x86-64':'./UPnP/Bin/squeeze2upnp-linux-x86_64-static')
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
async function group_enqueue(group) {
	if (Array.isArray(group) && (group = group.filter(o => o))){
		if (group){
			const sum_group = sum_array(group)
			return new Promise(async (resolve, reject) => {
			const group_sums = group_buffer.map((o) => o?.sum_group)
			if(group_sums.findIndex((o) => o == sum_group) == -1){
				group_buffer.push({ group : group,sum_group : sum_group, resolve, reject })	
			} 
			group_dequeue().catch((err)=>{log && console.error(get_date(),"Deque error",err)})	
		})
		}
	}
}	
async function group_dequeue(timer = 10000) {
	if (rheos.working || !group_buffer.length) { 
		return 
	}
	const item = group_buffer[0]
	if (!item) {
		return
	}
	rheos.working = true
	if (item.group.length >1 ){
		await heos_command("group", "set_group", { pid: item?.group },timer,false)
		.catch((err) => {console.error(sum_array(item.group));item.resolve(err); rheos.working = false; group_dequeue() })
		group_buffer.pop()
		rheos.working = false 
		item.resolve()
	}
    else if(item.group.length == 1 ){
		rheos_groups.delete(item?.group[0])
		let res = await heos_command("group", "get_groups",timer,true).catch((err) => {console.error(sum_array(item.group));item.resolve(err); rheos.working = false; group_dequeue() })
		if (res?.payload?.length && res.payload.find(({gid}) => gid == item.group[0])) {
			await heos_command("group", "set_group", { pid: item?.group },timer,false).catch((err) => {console.error(sum_array(item.group));item.resolve(err); rheos.working = false; group_dequeue() })
		}
		group_buffer.pop()
		rheos.working = false 
		item.resolve()
	}	
	await group_dequeue()	
}
async function update_heos_groups() {
	const players = await get_players()
    const ungrouped = new Set()
	for (const player of players){
		const p = rheos_players.get(player.pid)
		if (!p){
			create_player(player)
		}
		if (p?.output && p.gid && !player.gid ){
			ungrouped.add(p.output)
			delete(p.gid)
		} 
		else if (p && player?.gid){
          	p.gid = player.gid
		}
	}
    ungrouped.size && services.svc_transport.ungroup_outputs([...ungrouped])		
	return new Promise(async function (resolve) {
		const res = await heos_command("group", "get_groups",10000,false).catch(err => console.error(get_date(),err))
		if (res?.payload?.length) {
			for await (const group of res.payload) {
				group.outputs = []
				group.sum_group = sum_array(group.players.map(player => player.pid))
				rheos_groups.set(group.gid,group)
				const players =	group.players.sort((a, b) => {let fa = a.role == "leader" ? 0 : 1; let fb = b.role == "leader" ? 0 : 1; return fa - fb} )
				for await (let player of players){
					let p = rheos_players.get(player.pid)
					player.gid = group.gid
					p?.output && group.outputs.push(p?.output)				
				}
	
				services.svc_transport.group_outputs(group.outputs,(err)=> err && console.error("ERROR GROUPING OUTPUTS",err))
		
				group_ready.emit("GROUP",group.sum_group,group.length)
			}
			
			
		} else {
			rheos_groups.clear()
		
		}
		await get_all_groups()
		resolve("SUCCESS")
	}).catch(err => console.error(get_date(),err))
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
				log && console.log("-> ",get_date(),"RHEOS: PAIRED    :",roon.extension_reginfo.extension_id)
				log && console.log("-> ",get_date(),"RHEOS: SERVER    : IP ADDRESS",roon.paired_core?.moo?.transport?.host || "NOT KNOWN")
				roon.paired = true
				rheos.mysettings.host_ip =  roon.paired_core?.moo?.transport?.host  
				await set_server(rheos.mysettings.host_ip )	
				services.svc_transport = core.services.RoonApiTransport	
				services.svc_transport.get_zones((err,data)=> {
					data.zones.map((z) => {
						rheos_zones.set(z.zone_id,z)
						services.svc_transport.control(z,'pause')
					})
				})
				services.svc_transport.subscribe_outputs(async function (cmd, data) {	
					if (cmd == "NetworkError") reject (roon)
					let removed = data?.outputs_removed || []
					let changed = data?.outputs_changed && data.outputs_changed.filter(o => o.source_controls && (o.source_controls[0].display_name.includes ("RHEOS") || o.source_controls[0].display_name.includes ("🔗")) ) || [];
					let added =   data?.outputs_added || []
					let avr_changes = data?.outputs_changed && data.outputs_changed.filter(o => o.source_controls && (o.source_controls[0].display_name.includes("​"))) || []
					if (data?.outputs_added){
						for (let o of data?.outputs_added){
							rheos_outputs.set(o.output_id,o)
					  		let p = [...rheos_players.values()].find(p => o.display_name.includes(p.name))
					  		if (p){
								p.output = o?.output_id;
							}
							if (p?.gid){						
								const group = rheos_groups.get(p.gid)
								group?.outputs && p?.output && p.pid === p.gid ? group?.outputs.unshift(p.output) : group?.outputs.push(p.output)
						 		if (group && (group?.players.length === group?.outputs.length)){
									services.svc_transport.group_outputs(group.outputs) 
									rheos_groups.delete(p?.gid)
						 		}
					  		} else if (o){
								services.svc_transport.ungroup_outputs([o]) 
					  		}
						} 
					}
					added.length && await update_outputs(added,"added")
					changed.length && await update_outputs(changed,"changed")
					removed.length && await update_outputs(removed,"removed")
					avr_changes.length && await update_outputs(avr_changes,"avr")
				})
				services.svc_transport.subscribe_zones(async function (cmd, data) {
					if (cmd == "NetworkError") reject (roon)
					data?.zones_seek_changed && data.zones_seek_changed.forEach( o  =>{
						const z = rheos_zones.get(o.zone_id)
						if (z){
							z.queue_time_remaining = o.queue_time_remaining
							z.seek_position = o.seek_position
						}
					})
					const added = data?.zones_added || []
					const removed = data?.zones_removed || []
						for (let z of removed){
							let zone = rheos_zones.get(z)
							if (zone) {log && console.log("-> ",get_date(),"RHEOS: ZONE      : REMOVING",zone.display_name,zone.outputs.length )}
							rheos_zones.delete(z)	
							const fixed = [...fixed_groups.values()].find(o => o.control_zone == z)
							if (fixed){

								fixed.control_zone == null
							}
						} 
					let changed = []
					if (data?.zones_changed ){
						changed = data.zones_changed.filter(o => (o.outputs[0]?.source_controls[0].display_name.includes ("🔗") || o.outputs[0]?.source_controls[0].display_name.includes ("RHEOS") ) )|| []
					}
		
					data && Array.isArray(data.zones_seek_changed) && update_position(data.zones_seek_changed)
					added.length && update_zones(added,true);
				    changed.length && update_zones(changed,false);
				
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
					log && console.warn("-> ",get_date(),"RHEOS: WARNING   ⚠ No UPnP/Squeezelite Processes Identified to Kill on closing core")
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
async function update_position(zones){
	for await (const o of zones){	
        if (o.zone_id){
			const zone = services.svc_transport.zone_by_zone_id(o.zone_id)
			const player = [...rheos_players.values()].find((p)=>{return ((p?.is_leader && p?.is_leader()) && (zone.outputs[0]?.source_controls[0].display_name.includes(p.name.trim().toUpperCase()+" (RHEOS")))})
			const fixed = fixed_groups.get(get_zone_group_value(zone))
			if (player && player?.now_playing?.one_line?.line1 !== zone?.now_playing?.one_line.line1 ){
				if (player?.mode == "FLOW" || player?.mode == "OFF") {	
					player.now_playing = zone.now_playing
					await write_meta(player,player.mode)
				}
				else if (!zone?.now_playing?.seek_position && zone?.is_seek_allowed ){
					player.now_playing = zone.now_playing
					await write_meta(player,player.mode)
					services.svc_transport.seek(zone,'absolute',(player?.now_playing?.seek_position+3),(err)=> {err && console.error("-> ",get_date(),"RHEOS: WARNING   ⚠ TRACK PLAYBACK:",player?.name,err)})	
				} 
			}		
		}
	}		  
}
async function update_status(message = "",warning = false){
	let RheosStatus = rheos_players.size + " HEOS Players on " + rheos.system_info[2] +" "+ rheos.system_info [3]+" "+ rheos.system_info [4] + ' at ' + rheos.system_info[0] + '  for ' + get_elapsed_time(start_time) + '\n'
	for (const zone of [...rheos_zones.values()].filter(zone => (zone?.outputs && get_player_by_name(get_output_name(zone.outputs[0])) && ! get_output_name(zone.outputs[0]).includes("🔗") && zone.state ==="playing") )) {	
		RheosStatus = RheosStatus + (zone.outputs.length == 1 ?"🎵 ":"🎶  ") + (zone.fixed?.zone?.output || zone.display_name) + "\t ▶ \t" + zone.now_playing?.one_line?.line1 + "\n"
	}
	message && (RheosStatus = RheosStatus + "\n" + message)
	services.svc_status.set_status(RheosStatus,warning)
}
async function set_server(ip) {
	try {
	  console.log("<- ",get_date(),"RHEOS: SERVER    : IMAGE SERVICE STARTED ON PORT : 9330")
	  await fs.writeFile('./UPnP/Profiles/server', ip + ":9330");
	} catch (err) {
	  console.log(err);
	}
}
async function get_all_groups(){
	all_groups.clear()
	for (const group of rheos_groups){
		all_groups.set(get_heos_group_value(group[1]),group[1])
	}
	for (const group of fixed_groups){
		all_groups.set(group[0],group[1])
	}
	return all_groups
}
async function control_zone(zone,control){
	return(new Promise((resolve, reject) => {
			services.svc_transport.control(zone,control, resolve)		
		})
	)
}	
async function get_outputs(counter = 0,regroup = false){
	try{
		services.svc_transport.get_outputs(async (err,ops)=> {
			if(err || !ops || !ops.outputs.length){
				return (err || null)
			} else {
				let outputs = ops.outputs.filter((op) => op.source_controls && op.source_controls[0].display_name.includes("RHEOS"))
				if (outputs){
					for (const o of outputs){
						if (o.source_controls){
							const player = [...rheos_players.values()].find (({name})=> o.source_controls[0].display_name.includes(name.toUpperCase()))
							if (player?.name){
								player.output = o.output_id
								player.zone =   o.zone_id		
							}
						} 
					}
				} else {
				start_up(true)
				}
			return(Promise.resolve("SUCCESS"))
			}
		})
	} catch {
		services.svc_status.set_status("DISCOVERING PLAYERS AND SETTING GROUPS",true)
		return []
	}
}
function makelayout(settings) {
	const players = [...rheos_players.values()]
	const ips = players.map(player => player?.name && new Object({ "title": player.model + ' (' + player.name.toUpperCase() + ') ' + ' : ' + player.ip, "value": player.ip }))
	ips.push({ title: "No Default Connection", value: 0})
	let l = {values: settings,layout: [],has_error: false}
	l.layout.push(ips.length > 1 ? { type: "dropdown", title: "Default Heos Connection", values: ips, setting: "default_player_ip" }: { type: "string", title: "Default Heos Player IP Address", maxlength: 15, setting: "default_player_ip" })
	l.layout.push({ title: "Enable AVR Zone Control ", type: "dropdown", setting: 'avr_control', values : [{title: "ON", value : 1},{title : "OFF", value :0}]})
	l.layout.push({ title: "Enable Fixed HEOS Groups ", type: "dropdown", setting: 'fixed_control', values : [{title: "ON", value : 1},{title : "OFF", value :0}]})
	l.layout.push({ title: "Enable Logging ", type: "dropdown", setting: 'log', values : [{title: "ON", value : true},{title : "OFF", value :false}]})
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
	for (const player of rheos_players) {
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
		for (let group of all_groups) {
			let name = group[1].players.map(player=>player.name).toString()
			let values = []
			values.push({title: "HI RES FIXED GROUP", value: 192000})	
			values.push({title: "CD RES FIXED GROUP", value: 48000})	
			values.push({title: "DELETE GROUP", value: -1})
			_fixed_groups.items.push({	title: name, type: "dropdown", values: values, setting: group[1].sum_group})
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
function monitor_avr_status() {


	return rheos.monitor = setTimeout(async () => {
		
		let avrs = [...rheos_players.values()].filter(p => p.type === "AVR")
		for await (const avr of avrs){
			!rheos.block_avr_update && rheos.mysettings.avr_control && update_avr_status(avr,'monitor').catch(() => {console.error("⚠ ERROR MONITORING AVR STATUS")})
		}
	 // monitor_avr_status();
	}, 10000)
}
function get_zone_group_value(z){
	let zone = z
	if (typeof(z) !== 'object'){
		zone = rheos_zones.get(z) || rheos_zones.get(z?.zone_id) || false
	}
	zone.sum_array = zone.outputs.reduce((acc,curr)=> acc + ([...rheos_players.values()].find(({output})=> output == curr.output_id)?.pid || 0),0)
	return (zone.sum_array)
}
function get_heos_group_value(group =''){	
	let selected = 0
	if (Array.isArray(group.players)){	
        selected =(sum_array(group?.players.map(player => player.pid)))
	} else if (Array.isArray(group) && typeof group[0] == 'string' && group[0].includes ("+")){
			selected = sum_array((group[0]?.split(' + ').map(player => player?.pid ||  get_pid(player))))
	} else if (Array.isArray(group)){
		selected=(sum_array(group.map(player => rheos_players.get(player)?.pid || get_pid(player))))
    } 
	return(selected)
}
function get_pid(player_name) {
	if (rheos_players.size ) {
		let player = [...rheos_players.values()].find((player) => player?.name?.trim().toLowerCase() === player_name?.trim().toLowerCase())
		return player?.pid || 0
	}
}
function get_pid_by_op(op) {
	if (rheos_players.size ) {
		let player = [...rheos_players.values()].find((player) => player?.output === op)
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
function sum_array(array) {
	if (array == undefined || !Array.isArray(array)) { return 0 }
	let total = array?.reduce(function (acc, cur) { return acc + cur }, typeof (array[0]) == 'string' ? "" : 0)
	return total
}
function get_elapsed_time(start_time) {
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
function init_signal_handlers() {
    const handle = async function(signal) {
		console.warn("\r<- ",get_date(),"RHEOS: SYSTEM    ⚠ RHEOS IS SHUTTING DOWN")
		image_server.close()
		try{
			for (const zone of rheos_zones){
                if (zone[1].outputs.length>1){
					services.svc_transport.ungroup_outputs(zone[1].outputs)
				}
			}
			for (const child of Object.values(rheos.processes) ){
				process.kill(child.pid,signal); 
			}	
			process.exit(1)
		} catch{
			console.log("ERROR SHUTTING DOWM")
		}
    };
    process.on('SIGTERM', handle);
    process.on('SIGINT', handle);
}
function get_player_by_name(name) {
	return [...rheos_players.values()].find((player) => {player?.name?.trim().toLowerCase() === name?.trim().toLowerCase()})
}
function to_title_case(str) {
	return str.replace(
	  /\w\S*/g,
	  function(txt) {
		return txt.charAt(0).toUpperCase() + txt.substr(1).toLowerCase();
	  }
	)
}  
function suppressExperimentalWarnings (p){
	const originalEmit = p.emit
	p.emit = function (event, warning) {
	  	if (event === 'warning' && warning?.name === 'ExperimentalWarning') {
			return false
	  	}
		return originalEmit.apply(p, arguments);
	}
}
function validateIPAddressOptimized(ip) {
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
function get_date(){
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
process.on('uncaughtException', (err) => {
	console.error('Uncaught exception:', err);
	Object.entries(rheos.processes).forEach(child => {
    console.log('Terminating child processes...',child.pid)
	for (const child of Object.values(rheos.processes) ){
		process.kill(child.pid,'SIGTERM')
	  }	
	})
	process.exit(1)
})

"® ♫ ░ ▓ 🎼"