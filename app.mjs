const version = "0.10.1-0"
"use-strict"
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
import {clearTimeout } from "node:timers"
var log = process.argv.includes("-l")||process.argv.includes("-log")
var squeezelite ="squeezelite" 
const fixed_groups = new Map()
const all_groups = new Map()
const services = {svc_status:{},svc_transport :{},svc_volume_control :{},svc_settings : {}}
const rheos = {processes:{},mode:false, discovery:0,working:false, avr:{},has_avr:false,system_info:[ip.address(),os.type(),os.hostname(),os.platform(),os.arch()],myfixed_groups:[],fixed_group_control:{},block_avr_update:false}
const roon = await connect_roon().catch((err)=> {console.error(new Date().toLocaleString(),"Failed to connect with ROON server",err)})
const start_time = new Date()
const group_buffer = []
const avr_buffer = {}
const exec = (child.exec)
const spawn = (child.spawn)
const rheos_players = new Map()
const rheos_zones = new Map()
const rheos_outputs = new Map()
const rheos_groups = new Map()
const fixed_players = new Set()
const group_pending =[]
const avr_zone_controls = {}
const avr_volume_controls = {}
const rheos_connect = RheosConnect.Telnet
const sound_modes = ["MSSTEREO","MSDIRECT","MSPURE DIRECT","MSMCH STEREO","MSVIRTUAL"]
suppressExperimentalWarnings(process)
init_signal_handlers()
exec("pkill -f -9 UPnP")
exec("pkill -f -9 squeezelite")
await start_up().catch((err) => console.error("⚠ ERROR STARTING UP",err))
async function start_up(){
	return new Promise (async function (resolve,reject)	{
	await start_roon().catch(err => console.error(new Date().toLocaleString(),"⚠ Error Starting Roon",err => {throw error(err),reject()}))
	await start_heos().catch((err) => {console.error(new Date().toLocaleString(),"⚠ Error Starting Heos",err);reject()})
	let c = spawn("squeezelite")
		c.on('error', async function(err) {
		log && console.error(new Date().toLocaleString(),'SQUEEZELITE NOT INSTALLED : LOADING BINARIES');
		squeezelite = await choose_binary("squeezelite",true).catch(err => console.error(new Date().toLocaleString(),"⚠ Error Loading Squeezelite Binaries",err => {console.error(err),reject()}))
	})
	console.log("SYSTEM INFORMATION:",rheos.system_info.toString(),"Version :",roon.extension_reginfo.display_version, "NODEJS VERSION:",process.version)
	await start_listening().catch((err) => {console.error(new Date().toLocaleString(),"⚠ Error Starting Listeners",err);reject()})
	await update_heos_groups().catch( err => {console.error(new Date().toLocaleString(),"⚠ Error Updating HEOS groups",err);reject()})
	await create_zone_controls().catch( err => {console.error(new Date().toLocaleString(),"⚠ Error Creating Zone Controls",err);reject()})
	await create_fixed_group_control().catch( err => {console.error(new Date().toLocaleString(),"⚠ Error Creating Fixed Groups",err);reject()})
	rheos.mysettings.fixed_control && await load_fixed_groups().catch( err => {console.error(new Date().toLocaleString(),"⚠ Error Loading Fixed Groups",err);reject()})
	Object.entries(rheos.mysettings).filter(o => isNaN(o[0])).forEach(o => log && console.log("-> ",new Date().toLocaleString(),"RHEOS: SETTING",to_title_case(o[0].padEnd(20 ,".")),o[1] ? (o[1] === true || o[1] === 1) ? "On" : o[1] : o[1]===0 ? "Off" : "Not Defined"))
	rheos.mysettings.avr_control && monitor_avr_status()
	resolve()
	}) .catch( err => {
			console.error(new Date().toLocaleString(),"⚠ Error Starting Up")
			process.exit(err)
		})
}
async function add_listeners() {
	rheos.listeners = true
	rheos.connection[0].socket.setMaxListeners(32)
	rheos.connection[1].socket.setMaxListeners(32)
	rheos.connection[1].write("system", "register_for_change_events", { enable: "on" })
		.onClose(async (hadError) => {setTimeout(()=>{
			console.error(new Date().toLocaleString(),"⚠ Listeners closed", hadError)
			rheos.listeners = false
			!hadError && start_up().catch(err => { console.error(new Date().toLocaleString(),err) })},5000)
		})
		.onError((err) => {
			console.error(new Date().toLocaleString(),"⚠ HEOS REPORTS ERROR", err)})
		.on({ commandGroup: "event", command: "groups_changed" }, async (res) => {
			log && console.log("-> ",new Date().toLocaleString(),"RHEOS: EVENT:",res.heos.command.command)
			await update_heos_groups().catch(err => console.error(new Date().toLocaleString(),"⚠ Error Updating HEOS Groups",err))
			for (const group of [...rheos_groups.values()]) {
				const pending_index = group_pending.findIndex(g => g.group.gid == group.gid)
				const zone = services.svc_transport.zone_by_output_id(rheos_players.get(group.gid)?.output)
				if (pending_index > -1 && get_zone_group_value(zone)=== get_heos_group_value(group) ){
					log && console.log("->" ,new Date().toLocaleString(),"RHEOS: FIXED GROUP NOW GROUPED ",zone.display_name)
					group_pending[pending_index].status ="grouped"
						let int = setInterval((gid) => {
							const zone = services.svc_transport.zone_by_output_id(rheos_players.get(gid)?.output)
							if (zone.state == "playing"|| zone.state == "loading" ) {
								log && console.log("->" ,new Date().toLocaleString()," RHEOS: FIXED GROUP NOW PLAYING",zone.display_name)
								group_pending.splice(pending_index,1)
								clearInterval(int)
							} else {
								log && console.log("-> " ,new Date().toLocaleString(),"RHEOS: FIXED GROUP TRYING TO PLAY",zone.display_name)
								zone.is_play_allowed && services.svc_transport.control(zone,'play')
							}
						},1000,group.gid)
				} else {
					const players =	group.players.sort((a, b) => {let fa = a.role == "leader" ? 0 : 1; let fb = b.role == "leader" ? 0 : 1; return fa - fb} )	
					const new_outputs = players?.map(player => rheos_players.get(player.pid)?.output).filter(Boolean) || []
					const old_outputs = zone?.outputs.map(output => !output.source_controls[0].display_name.includes("​") && output?.output_id) || []
					if (get_zone_group_value(zone) !== get_heos_group_value(group)) {
						if (new_outputs?.length >1 && new_outputs?.length > (old_outputs.filter (Boolean)).length) {
							services.svc_transport.group_outputs(new_outputs)
						} else {
							const removed_outputs = old_outputs?.filter(op => !new_outputs?.includes(op))
							services.svc_transport.ungroup_outputs(removed_outputs)
						}
					}	
				} 
			}
		})
		.on({ commandGroup: "event", command: "players_changed" }, async (res) => {
			log && console.log("-> ",new Date().toLocaleString(),"RHEOS: EVENT:",JSON.stringify(res.heos.message.parsed))
		    await compare_players()
		})
		.on({ commandGroup: "event", command: "sources_changed" }, async (res) => {
			log && console.log("-> ",new Date().toLocaleString(),"RHEOS: EVENT:",JSON.stringify(res.heos.message.parsed))
		})
		.on({ commandGroup: "event", command: "player_now_playing_changed" }, async (res) => {
			const {pid} = res.heos.message.parsed
			const player =  rheos_players.get(pid)
			if(!player.rheos && !fixed_players.has(player?.pid) && (!player?.gid || player?.pid === player?.gid)){
				console.log("-> ",new Date().toLocaleString(),"RHEOS: EVENT:",player.name,res.heos.command.command,res.heos.message.parsed)
				const {payload = {} } = await heos_command("player", "get_now_playing_media",{pid : pid})
				const {mid = "",sid = ""} = payload
				if (sid == 1024 && mid === '1'){
					player.rheos = true
					log && console.log("-> ",new Date().toLocaleString(),"RHEOS: NOW PLAYING FROM RHEOS:",player.name,player.now_playing?.one_line?.line1, player.position || 0," of ",player.duration || player.next)
				} else {
					player.rheos = false   
					delete(player.now_playing)	
					    let zone  = await update_zone(player.zone).catch(
								()=>{console.log("ZONE NOT AVAILABLE ON CHANGED")
							}
						)
						if (zone){
							services.svc_transport.control(player.zone,'stop')
						}
						log && console.log("-> ",new Date().toLocaleString(),"RHEOS: STOPPING RHEOS AS NOW PLAYING CHANGED ",sid,mid,player.name,player.state)
				}
				
			} else if (!fixed_players.has(player?.pid) && (!player?.gid || player?.pid === player?.gid)){
				const res = await heos_command("player", "get_now_playing_media",{pid : pid})
				player.payload = res.payload
			}
			rheos_players.set(player.pid,player)	
		})
		.on({ commandGroup: "event", command: "player_state_changed" }, async (res) => {
			const {pid,state} = res.heos.message.parsed
			const player =  rheos_players.get(pid)
			clearInterval(player.force_play)
			if(player?.zone && !fixed_players.has(player?.pid) && (!player?.gid || player?.pid === player?.gid)){
				let zone = await update_zone(player.zone).catch(
						()=>{console.log("ZONE NO LONGER EXISTS")
					}
				)
				player.state = state
				rheos_players.set(player.pid,player)
				if (zone?.state === 'playing' && state === "play"){
					const  {payload  :{mid = "",sid = ""}}= await heos_command("player", "get_now_playing_media",{pid : pid})
					if (mid && mid !== '1'){
						player && services.svc_transport.control(player.zone,'stop')
						log && console.log("-> ",new Date().toLocaleString(),"RHEOS: STOPPING RHEOS ZONE AS PLAYING STATE CHANGED TO NON RHEOS",sid,mid,player.name,player.state)
					    await create_player(player).catch(()=>{console.error(new Date().toLocaleString(),"Failed to re-create player",player)})
					}
				}
			}
		})
		.on({ commandGroup: "event", command: "repeat_mode_changed" }, async (res) => {
			log && console.log("-> ",new Date().toLocaleString(),"RHEOS: EVENT:",JSON.stringify(res.heos.message.parsed))
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
			log && console.log("-> ",new Date().toLocaleString(),"RHEOS: EVENT:",JSON.stringify(res.heos.message.parsed))
			const {pid,shuffle} = res.heos.message.parsed
			const zone = services.svc_transport.zone_by_output_id(rheos_players.get(pid)?.output) 
			if (zone){
				services.svc_transport.change_settings(zone,{shuffle : shuffle == "on"  })
			}
		})
		.on({ commandGroup: "event", command: "player_playback_error" }, async (res) => {
			const {pid,error} = res.heos.message.parsed
			const player = rheos_players.get(pid)
		    if (player?.zone){
				log && console.error("-> ",new Date().toLocaleString(),"RHEOS: ⚠ WARNING:",player.name,error)
			}	
		})
		.on({ commandGroup: "event", command: "player_volume_changed" }, async (res) => {
			const { heos: { message: { parsed: { mute, level, pid } } } } = res, player = rheos_players.get(pid), output = rheos_outputs.get(player?.output)
			if (output && roon.paired ){
				if (level !== player?.volume?.level) {
					log && console.log("-> ",new Date().toLocaleString(),"RHEOS: EVENT:",JSON.stringify(res.heos.message.parsed))
					player.volume.level = level
					services.svc_transport.change_volume(output, 'absolute', level)
				}
				if (mute !== player.volume.mute) {
					log && console.log("-> ",new Date().toLocaleString(),"RHEOS: EVENT:",JSON.stringify(res.heos.message.parsed))
					player.volume.mute = mute
					services.svc_transport.mute(player.output, (mute == 'on' ? 'mute' : 'unmute'))		
				}
			} 	
		})
}
async function start_heos(counter = 0) {
	if (counter == 10){ process.exit(1)} 
	return new Promise (async function (resolve,reject){
		process.setMaxListeners(32)
		if (!rheos.connection) {
			console.log("DEFAULT HEOS CONNECTION IP IS",rheos.mysettings.default_player_ip || "NOT SET")
			try {
				rheos.connection =   await Promise.all([HeosApi.connect(rheos.mysettings.default_player_ip),HeosApi.connect(rheos.mysettings.default_player_ip)])
				console.log("-> ",new Date().toLocaleString(),"RHEOS: CONNECTED TO DEFAULT PLAYER IP",  rheos.mysettings.default_player_ip )	
			} catch {
				let discovered_player = await HeosApi.discoverOneDevice()
				rheos.connection =   await Promise.all([HeosApi.connect(discovered_player),HeosApi.connect(discovered_player)])
				console.log("-> ",new Date().toLocaleString(),"RHEOS: CONNECTED TO FIRST DISCOVERED PLAYER AT",discovered_player)
			} 	
		}
		rheos.connection[0].socket.setMaxListeners(32)
		rheos.connection[1].socket.setMaxListeners(32)
		const players = await get_players().catch(async ()=>{
			console.error("⚠ ERROR GETTING PLAYERS",counter)
			counter ++
			await start_heos(counter)
		})
		if (Array.isArray(players)&& players.length){
			await set_players(players).catch(()=>{console.error(new Date().toLocaleString(),"RHEOS: ERROR: ⚠ SETTING PLAYERS")})
			roon.save_config("settings",rheos.mysettings);
			roon.save_config("players",[...rheos_players.values()].map((o) => {let {gid,Z2,PWR,volume,output,zone,state,status,group,now_playing,position,duration,rheos,next, ...p} = o;return(p)}));
			resolve	()
		} else {
			console.error("UNABLE TO DISCOVER PLAYERS",counter)
			counter ++
			reject(start_heos(counter))
		}		
	})
}
async function get_device_info(ip){
	if (!ip){return}
	const response = await fetch('http://' + ip + ':60006/upnp/desc/aios_device/aios_device.xml').catch(err => console.error(err))
	const body = await response.text().catch(err => console.error(err))
	let re = new RegExp("<UDN>(.*?)</UDN?>")
	const upn = body.search(re)
	re = new RegExp("<lanMac>(.*?)</lanMac?>")
	const mac = body.search(re)
	return([body.slice(upn+5,upn+46),body.slice(mac+8,mac+25)])
}
async function compare_players(){
	let players = await get_players().catch(() => {(console.error(new Date().toLocaleString(),"Failed to create players - recomparing"));compare_players()})
	let new_players = players.map(p => p.pid)
	let old_players = [...rheos_players.keys()]
	if (sum_array(new_players) !== sum_array(old_players)){
		const added_players = new_players.filter(p => !old_players.includes(p))
		const removed_players = old_players.filter(p => !new_players.includes(p))
		removed_players.length && await delete_players(removed_players)
		added_players.length && await set_players(added_players.map(p => players.find(o => o.pid == p))).catch(()=>{console.error(new Date().toLocaleString(),"Failed to create players",added_players)})
	} 	
}
async function reboot_heos_server(){
	let res = await heos_command("system", "reboot",20000)
	console.log("REBOOTING SYSTEM",res)	
}
async function delete_players(players){
	if (!Array.isArray(players)){return}
	const removed = []
	for (const pid of players){
		if (rheos.processes[pid]?.pid){
			process.kill(rheos.processes[pid].pid,'SIGKILL')
			delete rheos.processes[pid]
			removed.push(rheos_players.get(pid))
			rheos_players.delete(pid)
		}
	}
	console.log("REMOVED PLAYERS")
	console.table(removed, ["name", "pid", "model", "ip", "resolution","network","udn","mode"]) 
	return
}
async function set_players(players){
	if (!Array.isArray(players) || !players.length){return}
	const added = []
	for await (let player of players) {
		if (player?.pid && typeof(player) === "object") {
			if (rheos.myplayers.find(p => p.pid == player.pid)) { 
				player.resolution = rheos.myplayers.find(p => p.pid == player.pid)?.resolution
				player.mode = rheos.myplayers.find(p => p.pid == player.pid)?.mode || "FLOW"
				player.auto_play = rheos.myplayers.find(p => p.pid == player.pid)?.auto_play 
				player.network = player.network || rheos.myplayers.find(p => p.pid == player.pid)?.network 
			    player.ip = player.ip || rheos.myplayers.find(p => p.pid == player.pid)?.ip && console.error(new Date().toLocaleString(),"Unable to get current player ip")
			} else { 
				player.resolution = "CD" 
				player.auto_play = "OFF"
				player.mode = "FLOW"
			}	
			const {payload :{mid = "",sid = ""}} = await heos_command("player", "get_now_playing_media",{pid : player.pid})
			player.rheos = Boolean(mid ==="1" && sid == 1024)
			const info = await get_device_info(player.ip).catch(()=>{console.error(new Date().toLocaleString(),"Unable to get player UDN")})
			log && console.log("-> ",new Date().toLocaleString(),"RHEOS: PLAYER SET",player.name,info)
			if (info){
				player.udn = (info[0])
				player.mac = (info[1])
			} else {
				player.udn =  rheos.myplayers.find(p => p.pid == player.pid)?.udn
				player.mac =  rheos.myplayers.find(p => p.pid == player.pid)?.mac 
			}
			if (rheos.myplayers.findIndex(p => p.pid == player.pid) == -1 ){
				rheos.myplayers.push(player)
			}
			if (player.udn){
				player.volume = {}
				player.state = await read_player_status(player.pid)
				added.push(player)
				log && console.log("-> ",new Date().toLocaleString(),"RHEOS: CREATING PLAYER",player.name)
	 		    await create_player(player).catch(()=>{console.error(new Date().toLocaleString(),"Failed to create player",player)})
			}
		}	
	}
	if (added.length){
	console.table(added, ["name", "pid", "model", "ip", "resolution","network","udn","mode"]) 
	}	 
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
					log && console.log(players.payload.length,"HEOS PLAYERS IDENTIFIED",)
					resolve(players?.payload)
				}	
				break
				case (players.heos.result === "failed"):{
					console.error(new Date().toLocaleString(),"⚠ UNABLE TO GET PLAYERS",players)
					reject()
				}			
				break
				case (players?.heos.message.unparsed == "command under process"):{
					console.log("COMMAND UNDER PROCESS - TRYING FALLBACK CONNECTION AFTER 2 second DELAY")	
				    await delay(2000)
					rheos.connection[1]
					.write("player", "get_players", {})
					.once({ commandGroup: 'player', command: 'get_players' }, (players) => {
						if (players?.payload?.length > 0 && players?.payload.every((p)=> p?.pid)) {
							console.log("EVENTUALLY GOT",players.payload.length,"PLAYERS",)
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
					console.error(new Date().toLocaleString(),"DEFAULT UNABLE TO GET PLAYERS",players)
					reject()	
				} 
			}
		})
	})
}
async function get_now_playing(pid){
	let res = await heos_command("player", "get_now_playing_media",{pid : pid})
	return (res || {})
}
async function read_player_status(pid){
	const res = await heos_command("player", "get_play_state",{pid : pid})
	const player = rheos_players.get(res?.parsed?.pid)
	if (player){
		player.state = res?.parsed?.state
	} 
	return(res?.parsed?.state)
}
async function create_player(player) {
	log && console.log("-> ",new Date().toLocaleString(),"RHEOS: CREATING",player.name,"WITH STATE",player.state)
	const app = await (choose_binary()).catch(err => console.error(new Date().toLocaleString(),"Failed to find binary",err))
	if (rheos.processes[player.pid]){
        let p = rheos.processes[player.pid].pid
		setTimeout((p)=>{
			try {process.kill(Number(p),'SIGKILL')} catch (player) {console.warn("-> ",new Date().toLocaleString(),"RHEOS: UNABLE TO DELETE",player.name)}},5000,p)
	} 
	await set_player_resolution(player).catch(err =>{console.log(err)})
	delete(rheos.processes[player.pid])
	rheos.processes[player.pid] = spawn(
		app,
		['-b', rheos.system_info[0], 
		'-Z',
		'-M', player.name + "(RHEOS: "+player.model+")",
		'-x', './UPnP/Profiles/' + player.name + '.xml',
		'-f', './UPnP/Profiles/' + player.name + '.log',
		'-d','all=info',
		'-s',rheos.mysettings.host_ip || null,
		'-k'	
		],{ stdio: ['pipe',process.stderr,'pipe'] }, rheos_players.set(player.pid,player)
	)	
	rheos.processes[player.pid].on('uncaughtExceptionMonitor', async (err,origin) => {	
		console.error("-> ",new Date().toLocaleString(),"RHEOS: UNCAUGHT EXCEPTION",new Date().toLocaleString(),player.name),err,origin
	})
	rheos.processes[player.pid].on('exit',  () => {	
		log && console.log("-> ",new Date().toLocaleString(),"RHEOS: PLAYER EXIT",new Date().toLocaleString(),player.name)
		delete(rheos.processes[player.pid])
	})
	rheos.processes[player.pid].on('spawn', () => {
		log && console.log("-> ",new Date().toLocaleString(),"RHEOS: PLAYER CREATED",new Date().toLocaleString(),player.name)
	}) 
	return (rheos.processes[player.pid])
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
async function create_fixed_group(group){
	log && console.log("->",new Date().toLocaleString(),"RHEOS: CREATING FIXED GROUP",JSON.stringify(group))
	const fixed = Math.abs(group.sum_group).toString(16);
	group.display_name = "🔗 " + group.name
	if (!fixed_groups.has(group.sum_group)){
		fixed_groups.set(group.sum_group,group)
		rheos.mysettings[group.sum_group.toString()]=[group.resolution]
		rheos.myfixed_groups = [...fixed_groups.values()]
		roon.save_config("fixed_groups", rheos.myfixed_groups)
	}
	if (!rheos.processes[fixed]){	
		const mac = "bb:bb:bb:"+ fixed.replace(/..\B/g, '$&:').slice(1,7)
		log && console.log("->",new Date().toLocaleString(),"RHEOS: SPAWNING FIXED GROUP",group.display_name,mac)
		console.log("-> RHEOS: SPAWNING FIXED GROUP",group.display_name,mac,fixed)
		rheos.processes[fixed] = spawn(squeezelite,["-a","24","-r",group.resolution +" : 500","-M",group.display_name,"-m", mac,"-o","-","-p","1","-W","-v",'-s', rheos.mysettings.host_ip])
	}
	rheos_groups.get(group.gid) && await group_enqueue(group.gid)
	return
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
			const output = [...rheos_outputs.values()].find(o => o.source_controls[0].display_name == rheos.myfixed_groups[index].display_name)
			console.log("->",new Date().toLocaleString(),"RHEOS: REMOVING FIXED GROUP",output?.display_name)
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
async function start_roon() {
	console.error(new Date().toLocaleString(),"STARTING RHEOS")
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
	if (rheos.mysettings.fixed_control){
		let  g = roon.load_config("fixed_groups") || []
		rheos.myfixed_groups = g
		Array.isArray (rheos.myfixed_groups)  &&   rheos.myfixed_groups?.forEach(g => {
			g.state = 'paused';fixed_groups.set(g.sum_group,g)
		})			
	}
	services.svc_settings = new RoonApiSettings(roon, {
		get_settings: async function (cb) {
			Array.isArray(rheos.myplayers) && rheos.myplayers.forEach(p => {
				const pid = Math.abs(p.pid)
				rheos.mysettings["P"+pid] = p.resolution
				rheos.mysettings["M"+pid] = p.mode
				rheos.mysettings["A"+pid] = p.auto_play	
			})
			await get_all_groups()
			Array.isArray(rheos.myfixed_groups) && rheos.myfixed_groups.forEach(g => {rheos.mysettings[g.sum_group] = (g.resolution)})
			cb(makelayout(rheos.mysettings))
		},
		save_settings: async function (req, isdryrun, settings) {
			let l = makelayout(settings.values)
			if (!isdryrun && !l.has_error) {
				console.log(Object.keys(rheos.processes).length)
				if (settings.values.clear_settings ) {
					exec("pkill -f -9 UPnP")
					exec("pkill -f -9 squeezelite")
					settings.values = def.settings
					rheos.mysettings.clear_settings = 0
					rheos.system_info = [ip.address(), os.type(), os.hostname(), os.platform(), os.arch()]
					await start_heos()
					console.log("-> ",new Date().toLocaleString(),"RHEOS: RESET TO DEFAULTS")
					update_status("Settings returned to defaults",true)
				} 
				if (settings.values.refresh_players) {
					let players = await get_players().catch(err => {console.error(new Date().toLocaleString(),"⚠ Error Getting Players",err, reject())})
					exec("pkill -f -9 UPnP")
					exec("pkill -f -9 squeezelite")
					await set_players(players)
					console.log("-> ",new Date().toLocaleString(),"RHEOS: REFRESHED PLAYERS")
					update_status("Players refreshed",true)
					settings.values.refresh_players = 0	
				}
				if (settings.values.reboot_heos) {
					reboot_heos_server()
					console.log("-> ",new Date().toLocaleString(),"RHEOS: REBOOTING HEOS SERVER")
					settings.values.reboot_heos = 0	
					process.exit(2)
				
				}
				for await (let player of [...rheos_players.values()]){	
					const pid = player.pid	
					if(player.resolution !== l.values["P"+pid] ){
						player.resolution = l.values["P"+pid] || "CD"
						rheos.mysettings["P"+pid] = player.resolution
						await create_player(player).catch(()=>{console.error(new Date().toLocaleString(),"Failed to create player",JSON.stringify(player))})
						log && console.log("-> ",new Date().toLocaleString(),"RHEOS: RESET PLAYER RESOLUTION")
						console.table([player], ["name", "pid", "model", "ip", "resolution","network","udn","mode"]) 
						update_status(`${player.name} set to ${player.resolution}`,false)
						rheos_players.set(player.pid,player)
					}
					if(player.mode !== l.values["M"+pid] ){
						player.mode = l.values["M"+pid] || "FLOW"
						rheos.mysettings["M"+pid] = player.mode
						await create_player(player).catch(()=>{console.error(new Date().toLocaleString(),"Failed to create player",JSON.stringify(player))})
						log && console.log("-> ",new Date().toLocaleString(),"RHEOS: RESET PLAYER MODE")
						console.table([player], ["name", "pid", "model", "ip", "resolution","network","udn","mode"]) 
						update_status(`${player.name} set to ${player.mode}`,false)
						rheos_players.set(player.pid,player)
					}
					if (Array.isArray(player.PWR)){
						if (player.auto_play !== l.values["A"+pid]){
							player.auto_play =  l.values["A"+pid]
							rheos.mysettings["A"+pid] = player.auto_play
							rheos.myplayers = [...rheos_players.values()]	
							update_status(`${player.name} autoplay delay set to ${player.auto_play} seconds`,false)
						}	
						rheos_players.set(player.pid,player)
					}
				}
				let players = [...rheos_players.values()].map((o) => {let {gid,Z2,PWR,volume,output,zone,state,status,group,now_playing,position,duration,rheos,next, ...p} = o;return(p)})
				roon.save_config("players",players);
				for await (const group of all_groups){
					group[1].resolution = settings.values[group[1].sum_group.toString()] 
					if (rheos.mysettings.fixed_control && settings.values[group[0]] >-1 ){
						create_fixed_group(group[1])
					} else {	
						remove_fixed_group(group[0],true)
					}
				}
				if (settings.values.fixed_control){
					await load_fixed_groups().catch(err => console.error(new Date().toLocaleString(),"⚠ Error Loading Fixed Groups",(err) => {throw error(err),reject()}))
				} else {
				  	await unload_fixed_groups().catch(err => console.error(new Date().toLocaleString(),"⚠ Error Unloading Fixed Groups",(err) => {throw error(err),reject()}))
				}
				if (settings.values.avr_control){ 
					if (settings.values.avr_control !== rheos.mysettings.avr_control){
						await create_zone_controls().catch( err => {console.error(new Date().toLocaleString(),"⚠ Error Creating Zone Controls",err);reject()})
					}
					let avrs = [...rheos_players.values()].filter(player => player.type == "AVR")
					for (let avr of avrs){
						avr_volume_controls[avr.pid]?.update_state({	state: {
							volume_type:  "number"
						}})
					}
					monitor_avr_status()
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
					clearTimeout(rheos.monitor)
				} 
				const select= ({
					default_player_ip,host_ip,streambuf_size,output_size,stream_length,seek_after_pause,volume_on_play,volume_feedback,accept_nexturi,flac_header,keep_alive,next_delay,max_safe_vol,avr_control,fixed_control,log_limit,log,clear_settings,refresh_players,cache
			    }) => ({
					default_player_ip,host_ip,streambuf_size,output_size,stream_length,seek_after_pause,volume_on_play,volume_feedback,accept_nexturi,flac_header,keep_alive,next_delay,max_safe_vol,avr_control,fixed_control,log_limit,log,clear_settings,refresh_players,cache
				})
				const selected = select(rheos.mysettings)
				const changed = select(settings.values)
				if (JSON.stringify(selected) !== JSON.stringify(changed)){
					update_status("UPDATING UPnP SETTINGS - PLEASE WAIT",false)
					roon.save_config("settings", changed)
					rheos.mysettings = changed
					log = changed.log
					exec("pkill -f -9 UPnP")
					exec("pkill -f -9 squeezelite")
					set_players([...rheos_players.values()])
	                let s = "Updated settings"
					update_status(s,false) 
				}	
				if (selected.default_player_ip !== changed.default_player_ip) {
					setTimeout(()=>{
						delete rheos.connection
						start_heos()
					},3000)
					console.log("-> ",new Date().toLocaleString(),"RHEOS: RESTARTING WITH CONNECTION TO ",settings.values.default_player_ip )
					update_status("Restarting With Connection to " + settings.values.default_player_ip,true)
				}
				roon.save_config("fixed_groups",rheos.myfixed_groups)
				rheos.myplayers = [...rheos_players.values()].map((o) => {let {gid,Z2,PWR,volume,output,zone,state,status,group,now_playing,position,duration,rheos,next, ...p} = o;return(p)})
				roon.save_config("players",rheos.myplayers);
			
				if (settings.values.avr_control !== rheos.mysettings.avr_control){
					rheos.mysettings.avr_control = settings.values.avr_control
					await start_up()
				}
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
       if(avr_buffer[ip].findIndex(o => {o.item[0] == ip && (o.item[1].slice(0,1) ==  command.slice(0,1)) && !isNaN(command.slice(2,4)) })>-1){
			log && console.error ("ALREADY BUFFERED",ip,command)
		}
		rheos.block_avr_update = true
	 	avr_buffer[ip].push({ item: Array(ip,command), resolve, reject })
		await avr_dequeue(ip).catch((err)=>{console.error(new Date().toLocaleString(),"Deque error",err)})	
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
		shellPrompt:"",
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
		log && console.log("<- ",new Date().toLocaleString(),"AVR  : REQUEST:",JSON.stringify(req.item))
		if (req) {
			log && console.log("-> ",new Date().toLocaleString(),"AVR  : COMPLETE:",(JSON.stringify(res,req)))
		}
		req && req.resolve(res)	
	}
	catch {
		log && console.error("-> ",new Date().toLocaleString(),"AVR  : INCOMPLETE:",(JSON.stringify(req.item)))
		req && req.resolve(res)
	}
	await avr_dequeue()	
}
async function create_zone_controls(err,count=0) {	
	if (!rheos_players.size && count <10){setTimeout(async ()=>{
		log && count  && console.error(new Date().toLocaleString(),"NO PLAYERS DETECTED- TRYING AGAIN",count )
		await create_zone_controls(false,count++)},500);
		return 
	} else if (rheos_players.size){
		let failed_connections= []
		for await (let player of rheos_players){
			if (player[1].model && (!player[1].model.includes("HEOS"))&&(!player[1].model.includes("Home"))){
				log && console.log("<- ",new Date().toLocaleString(),"AVR  : TESTING CONNECTION",player[1].name)
				err = connect_avr(player[0]).catch(err => console.error(err,"⚠  ERROR CONNECTING AVR",player.name))
				if (err) {failed_connections.push[player[1]]}
			}
		} 
		let i = 0
		while (failed_connections.length && i< 17){
			for await (let player of failed_connections){
				err = await connect_avr(player[0]).catch(()=> {console.error("⚠ FAILED TO CONNECT AVR")})
				err && failed_connections.shift()
			}	
			i++
		}
		if (i == 11){console.error(new Date().toLocaleString(),"⚠ FAILED TO SET AVR CONTROLS FOR ",failed_connections.map(p => p[1].name))}
		roon.save_config("players",[...rheos_players.values()].map((o) => {let {gid,Z2,PWR,volume,output,zone,state,status,group,now_playing,position,duration,rheos,next, ...p} = o;return(p)})); 
	} else {
		console.error(new Date().toLocaleString(),"⚠ UNABLE TO DISCOVER ANY HEOS PLAYERS - ABORTING")
		process.exit(1)
	}
	return
}
async function connect_avr(pid){	
	let avr = rheos_players.get(pid) 
	avr.PWR = await control_avr(avr.ip,"PW?").catch((err)=>{console.error(new Date().toLocaleString(),"⚠ FAILED TO CONNECT",err)})
	avr.Z2 = await control_avr(avr.ip,"Z2?").catch((err)=>{console.error(new Date().toLocaleString(),"⚠ FAILED TO CONNECT",err)})
	if (rheos.mysettings.avr_control && Array.isArray (avr.Z2) && avr.Z2.length >1){
		await create_avr_controls(avr).catch((err)=>{console.error(new Date().toLocaleString(),"⚠ FAILED TO CREATE AVR CONTROLS",err)})
		avr.type = "AVR"
		avr.status = []	
		let sm = await control_avr(avr.ip,"MS?").catch((err)=>{console.error(new Date().toLocaleString(),"⚠ FAILED TO CONNECT",err)})
		if (Array.isArray (sm) && sm.length >1){
			avr.sound_mode = sm[0]
		}
		return("AVR")						    
	} else { 
		avr.type = undefined;
		return(undefined)
	}
}
async function update_avr_status(avr){
	return new Promise(async function (resolve) {
		const avrs = Object.entries(avr_zone_controls).filter(o => o[1].state.ip == avr.ip)
		const status = new Set (await (control_avr(avr.ip,"\rZM?\rSI?\rMV?\rMU?\rZ2?\rZ2MU?\rZ?\rMS?\r")))
		roon.paired || log && process.stdout.write(new Date().toLocaleString()+ (" UNPAIRED\r"))
		if(services.svc_transport && roon.paired){
			if (rheos.mysettings.avr_control ){
				let s = [...status].join(" ")
				let index = 0
				for await (let control of avrs){
					const op = rheos_outputs.get(control[1].output?.output_id)
						log && console.log("-> ",new Date().toLocaleString(),"AVR  : CONTROL",JSON.stringify(control))
						if ((index === 0 && (status.has("ZMON") && status.has("SINET"))) || (index ===1 && (status.has("Z2ON") && status.has("Z2NET")) )) { 
							if (!op && control[1].state.status !== "selected"){
								control[1].state.status = "selected"
								control[1].update_state({supports_standby :false , status : "selected"})
								await create_avr_zone(avr,index)		
							}
						} else if(index == 2 ){
							const s = [...status]
							const MV = s.find(o => o.includes ("MS")) 
							if (MV && !control[1]?.state?.display_name?.includes(MV.slice(2))){
								control[1].state.display_name  = MV.slice(2)
								control[1].update_state({display_name :  avr.name + " ♫ " + to_title_case(MV.slice(2)), supports_standby :true, status : "indeterminate"})
							}	
						}
						else {
							control[1].state.status = "deselected"
							control[1].update_state({supports_standby :true, status : "deselected"})
							if (control[1].output ){
								services.svc_transport.ungroup_outputs([control[1]?.output.output_id])
								rheos_outputs.delete(control[1].output?.output_id)
								delete control[1].output 
							}	
						}
					if (op && index == 0){
						let MV = s.search(/MV\d/) 
						const level= s.slice(MV+2,MV+4)
						if (level && level != op?.volume.value ){
							services.svc_transport.change_volume(op,'absolute',level)
						}	
						if (status.has("MUON")){
							services.svc_transport.mute(op,'mute')
						} else if (status.has("MUOFF")){
							services.svc_transport.mute(op,'unmute')
						}
					} else if (op && index == 1){
						let Z2VOL = s.search(/Z2\d/)
						const level = s.slice(Z2VOL+2,Z2VOL+4)
						if (level && level != op?.volume.value){
							services.svc_transport.change_volume(op,'absolute',level)
						}
						if (status.has("Z2MUON")){
							services.svc_transport.mute(op,'mute')
						} else if (status.has("Z2MUOFF")){
							services.svc_transport.mute(op,'unmute')
						}
					}
					index ++
				}
				avr.status = [...status] 
				resolve()
			} 
		} else {
			resolve()
		}	
	})
}
async function create_avr_zone(avr,index){	
	log && console.log("-> ",new Date().toLocaleString(),"AVR  : ZONE IS ON",index === 0?  avr?.name + "​ Main​ Zone": avr?.name + "​ Zone​ 2")
	const hex = ((Math.abs(avr?.pid)+(index+1)).toString(16))
	if (! rheos.processes[hex]){
		const mac = "bb:bb:"+ hex.replace(/..\B/g, '$&:').slice(-11)
		rheos.processes[hex] = await spawn(squeezelite,["-M", index === 0?  avr?.name + "​ Main​ Zone": avr?.name + "​ Zone​ 2","-m", mac,"-o","-","-Z","192000"])
	}
	return	
}
async function create_avr_controls(player){	
	player = rheos_players.get(player.pid)
		for  (let index = 1; index < 3; index++) {
			switch (index) {
				case 1 :
					log && console.log("-> ",new Date().toLocaleString(),"RHEOS: CREATING AVR CONTROL",  player?.name +   "​ Main​ Zone")
				break
				case 2 :
					log && console.log("-> ",new Date().toLocaleString(),"RHEOS: CREATING AVR CONTROL",  player?.name +   "​ Zone​ 2")
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
						index : index
					},  
					convenience_switch : async function (req) {
						if (avr_zone_controls[(Math.abs(player.pid)+index).toString()].state.status == "standby"){
							log && console.log("PLAY",this .state.display_name)
						}
						req.send_complete("Success")						
					},  
					standby:  async function (req) {
					    avr_zone_controls[(Math.abs(player.pid)+index).toString()].update_state({ status : "indeterminate"})
						avr_zone_controls[(Math.abs(player.pid)+index).toString()].state.status = "standby"
						rheos.block_avr_update = true
						await control_avr( this.state.ip,this.state.index == 1 ?  "SINET" : "Z2NET" ).catch(()=>{console.error("⚠ ERROR SETTING AVR TO NETWORK")})
						await control_avr( this.state.ip,this.state.index == 1 ?  "ZMON" : "Z2ON" ).catch(()=>{console.error("⚠ ERROR SETTING AVR POWER")})
						rheos.block_avr_update = false
						await update_avr_status(rheos_players.get(this.state.pid)).catch(()=>{console.error("⚠ ERROR UPDATING AVR STATUS")})
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
					output :player.output,
					pid : player.pid,
					ip : player.ip,
					name : player.name		
				},  
				convenience_switch : async function (req) {
					setTimeout(	()=> { req.send_complete("Success") },3000	)		
				},  
				standby:  async function (req ) {
					rheos.mysettings.avr_control = 2
					rheos.block_avr_update = true
					await update_control(this.state.name,this.state.ip,this.state.display_name).catch(() => {console.error("⚠ ERROR STANDING BY",this.state.display_name)})	
					req.send_complete("Success")
					rheos.mysettings.avr_control = 1
					rheos.block_avr_update = false
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
					await update_avr_volume(this.state.player,mode,value)
					req.send_complete("Success");
					rheos.block_avr_update = fals
				},
				set_mute: async function (req, mode	) {
					rheos.block_avr_update = true
					await update_avr_volume(this.state.player,mode)
				   	req.send_complete("Success");
					rheos.block_avr_update = false
			}
		}
		console.log("CREATING CUSTOM VOLUME CONTROLLER",player.name)
		avr_volume_controls[player.pid] || (avr_volume_controls[player.pid] = services.svc_volume_control.new_device(volume_control))	
	return 
}
async function update_control (name,ip,present){
	let present_mode_index = sound_modes.findIndex(sm => sm.includes(present.slice(name.length + 3).toUpperCase()))
	let next = (present_mode_index<sound_modes.length-1 ? 	sound_modes.at(present_mode_index+1):sound_modes.at(0))
	await control_avr( ip, next).catch(()=>{console.error("⚠  ERROR UPDATING SOUND MODE ",name,ip,next)})
}
async function kill_avr_output(pid){
	const hex = (pid.toString(16))	
	if (rheos.processes[hex]?.pid){
		process.kill( Number(rheos.processes[hex]?.pid),'SIGKILL') 
		delete rheos.processes[hex]
	}	
	return
}
async function update_outputs(outputs,player){
	return new Promise(async function (resolve) {
		for await (let op of outputs) {				
			if (Array.isArray(op?.source_controls) && (op?.source_controls[0].display_name.includes ("RHEOS") || op?.source_controls[0].display_name.includes ("🔗") || op?.source_controls[0].display_name.includes ('​'))){
				op.source_controls === false && console.error(new Date().toLocaleString(),"⚠ NO SOURCE CONTROLS",op)
				const op_name = get_output_name(op) || ""
				const old_op = rheos_outputs.get(op.output_id) 
				const is_fixed = op.source_controls[0].display_name.includes("🔗") ? op.output_id : null
				if (op.source_controls[0].display_name.includes("​")){
					player = ( await get_player_by_name(op_name.split("​",1)[0])) || undefined
				} else {
					player = (op_name &&  await get_player_by_name(op_name)) || undefined
					if (player){
						player.output = op.output_id
						player.zone = op.zone_id
						op.player = player	
					}
				}
				const diff = op.volume?.value - old_op?.volume?.value || 0
				if (diff || (op.volume?.is_muted != old_op?.volume?.is_muted)){
					if (is_fixed){ 
					    const zone = services.svc_transport.zone_by_output_id(op.output_id)
						let fixed_group = fixed_groups.get(get_zone_group_value(zone)) 
                        if (fixed_group?.players){
							if (diff){
								for await (const p of fixed_group.players){
									let player = rheos_players.get(p.pid)
									let new_level = (player.volume.level || 0)+ diff
									if (new_level <= 0) {new_level = 0}
									if (new_level>0 && new_level<= op.volume.soft_limit){	
										await heos_command("player", "set_volume", { pid: player?.pid, level:  new_level}).catch(err => console.error(new Date().toLocaleString(),err))
									}	
								}
							} else if(op.volume?.is_muted != old_op?.volume?.is_muted){
									await heos_command("group", "set_mute", { gid: fixed_group.gid, state: op.volume.is_muted ? "on" : "off" }).catch(err => console.error(new Date().toLocaleString(),err))
							}
						}
					}
					else if (rheos.mysettings.avr_control && player?.type === "AVR" && op_name.includes('​')) {
							const control  = Object.values(avr_zone_controls).find(o => o.state.display_name == get_output_name(op))
							control && (control.output = op)
							if (diff) {
								player?.ip && control_avr(player.ip,(control.state.index === 1 ? "MV" : "Z2")+op.volume.value)
							}
							if (op.volume.is_muted != old_op?.volume?.is_muted) {
								player?.ip && control_avr(player.ip,(control.state.index === 1 ? "MU" : "Z2MU")+(op.volume.is_muted ? "ON" : "OFF"))
							}
					}
					else if (player?.pid) { 
						await update_player_volume(op,player)	 
					}
					if (!old_op &&  op?.volume?.value == 100){
						if (op?.volume?.value == 100 || !op.volume.value ){
							services.svc_transport.change_volume(op,"absolute",0)	
						}
					}	
				}	
				rheos_outputs.set(op.output_id,op)
			}
		}	
		resolve()
	}).catch(err => console.error(new Date().toLocaleString(),"⚠ ERROR UPDATING OUTPUTS",err))		
}				
async function update_zones(zones){
	return new Promise(async function (resolve) {
		for await (const z of zones) {
			let fixed = {}
			let old_zone = rheos_zones.get(z.zone_id) || {}
			let pending_index = -1
			rheos_zones.set(z.zone_id,z)
			if (z.outputs && z.outputs[0]?.source_controls && z.state !== old_zone?.state && ((z.outputs[0].source_controls[0].display_name.includes ("RHEOS") || 
				z.outputs[0].source_controls[0].display_name.includes ("🔗")) || 
				z.outputs[0].source_controls[0].display_name.includes ("​"))){
				log && console.log("-> ",new Date().toLocaleString(),"RHEOS: UPDATING ZONE",z.outputs?.[0].source_controls[0].display_name,z.state,old_zone.state , z.now_playing?.seek_position)		
				if (z.now_playing?.one_line?.line1 !== old_zone?.now_playing?.one_line?.line1 ){	
					const player = [...rheos_players.values()].find (o => o.output === z.outputs[0].output_id)
					if (player && player.now_playing?.one_line?.line1 !== z.now_playing?.one_line?.line1){
						player.position = 0
						player.rheos = true
						if (z.state === "playing") {player.now_playing = z.now_playing}
						player.need_meta = true
						//player.zone = z.zone_id
						await update_position([z.zone_id])
					}
				}
				if (z.state == "paused" || z.state == "stopped"){
					const player = [...rheos_players.values()].find (o => o.output === z.outputs[0].output_id)
					player && clearInterval(player.force_play)
				}
				pending_index  = group_pending.findIndex(g => g.group.players.find(p => p.role == "leader")?.name == get_output_name(z.outputs[0])) 
				if (rheos.mysettings.fixed_control){	
					fixed = ([...fixed_groups.values()].find(group => z.outputs.find(o => o.source_controls[0].display_name.includes ("🔗"))?.source_controls[0].display_name == group.display_name)) 
					if (fixed?.gid ){ 
						const index = group_pending.findIndex(z => z.group.gid === fixed.gid)
						if (z.outputs.length == 1 && index == -1 && z.state == "playing"){
								log && console.log("-> ",new Date().toLocaleString(),"RHEOS: SETTING FIXED GROUP",JSON.stringify(fixed?.name))
								const max_vol = await set_fixed_group(fixed.players)
								services.svc_transport.change_volume( z.outputs[0],'absolute',max_vol,  
								services.svc_transport.transfer_zone( z,services.svc_transport.zone_by_output_id(rheos_players.get(fixed.gid)?.output)))        
								group_pending.push({zone : z , group : fixed, status : "transferring"})	
						}
						else if (index == -1 && (z.state == "paused"  ) && z.outputs.length === fixed.players.length + 1) {
							log && console.log("-> ",new Date().toLocaleString(),"RHEOS: CLEARING FIXED GROUP",JSON.stringify(fixed?.name))
							const op = rheos_outputs.get(z.outputs[0].output_id)
							if (op){
								services.svc_transport.ungroup_outputs(z.outputs)
								fixed.players.forEach(p => fixed_players.delete(p.pid))	
							}
						}
					} 
					if (pending_index >-1){
						let pending = group_pending[pending_index]
						if (pending?.status == "transferring"){
							log && console.log("-> ",new Date().toLocaleString(),"RHEOS: TRANSFERRING TO FIXED GROUP",JSON.stringify(pending.zone.display_name))
							let zone_outputs = pending.group.players.sort((a, b) => {let fa = a.role == "leader" ? 0 : 1; let fb = b.role == "leader" ? 0 : 1; return fa - fb} ).map(player => rheos_outputs.get(rheos_players.get(player.pid)?.output))
							zone_outputs.push(pending.zone.outputs[0])
							zone_outputs = zone_outputs.filter(Boolean)
							pending.status="grouping" 
							log && console.log("-> ",new Date().toLocaleString(),"RHEOS: GROUPING FIXED GROUP",JSON.stringify(zone_outputs.map(o => o.display_name)))
							services.svc_transport.group_outputs(zone_outputs)
						} else {
							log && console.log("-> ",new Date().toLocaleString(),"RHEOS: PENDING",pending?.status)
						}
					}
				}
				const index = z.outputs.findIndex(o => o.source_controls[0].status == "standby")				
				if (index>-1 ){	
					const player = rheos_outputs.get(z.outputs[index]?.output_id)?.player
					if (Array.isArray(player?.PWR)&& !z.outputs[index]?.source_controls[0]?.display_name?.includes("​")){
						rheos.block_avr_update = true
						player.PWR = await control_avr(player?.ip,"PW?")
						if (Array.isArray(player.PWR) && player.PWR.includes("PWSTANDBY")){
							await control_avr(player.ip,"PWON")
							if (Number(player.auto_play )> -1){
								setTimeout((output)=> {services.svc_transport.control(services.svc_transport.zone_by_output_id(output),'play')},player.auto_play*1000,z.outputs[index].output_id)
							} 
						} else {
							await control_avr(player.ip,"PWSTANDBY")
						}
						rheos.block_avr_update = false
					} else if (rheos.mysettings.avr_control && z.outputs[index].source_controls[0]?.display_name.includes("​")){
						rheos.block_avr_update = true
						log && console.log("-> ",new Date().toLocaleString(),"AVR  : STANDBY ZONE",z.outputs[index].source_controls[0]?.display_name)
						services.svc_transport.ungroup_outputs([z.outputs[index]]);
						const control  = Object.entries(avr_zone_controls).find(o=> o[1].state.display_name == get_output_name(z.outputs[index])	)	
						if (control){
							let {state : {pid,ip,index}} = control[1]	
							let avr_status = rheos_players.get(pid).status
							if (index == 1 && avr_status.findIndex(o => o == "SINET")>-1 || index == 2 &&  avr_status.findIndex(o => o == "Z2NET")>-1 ){
								await control_avr(ip,index == 1 ? "ZMOFF" : "Z2OFF")
							}
						}	
						rheos.block_avr_update = false	
					}	
				} 
				if ( rheos.mysettings.avr_control && z.outputs.length == 1 && (z.outputs[0].source_controls[0].display_name).includes("​")){
						const control  = Object.values(avr_zone_controls).find(o => o.state.display_name == get_output_name(z.outputs[0]))
						if (control){
							rheos.block_avr_update = true
							let {update_state, state : {pid,status}} = control
							if (status === "deselected"){
								!z.outputs[0].display_name || z.outputs[0].display_name == "Unnamed" || await kill_avr_output((Math.abs(control.state.pid)+(control.state.index)))
								update_state({supports_standby: true, status :"standby" })
								status = "deselected"
							}  
							else if (status === "selected" && rheos_players.get(pid)){
								const  group = services.svc_transport.zone_by_output_id(rheos_players.get(pid).output)?.outputs
								group && group.push(z.outputs[0])
								group && services.svc_transport.group_outputs(group)
							}
							rheos.block_avr_update = false
						}
				}  
				if (z.outputs.length > 1){
					await update_heos_groups()
					const group = (rheos_groups.get(get_pid(get_output_name(z.outputs[0]))))
					const old_roon_group = old_zone?.outputs?.map(output => {get_pid(get_output_name(output))})
					const new_roon_group = z.outputs.map(output => get_pid(get_output_name(output))).filter(o => o)
					const heos_group = group?.players.map(player => player.pid);
				    if (new_roon_group.length > 1 && (sum_array(old_roon_group) !== sum_array(new_roon_group))  && (sum_array(new_roon_group) !== sum_array(heos_group))){
						await group_enqueue(new_roon_group)	
					}
					z.group = group 
				}		    
			} else if (z.outputs && z.outputs[0]?.source_controls && z.state !== old_zone?.state){
				z.outputs && console.log("NON RHEOS ZONE CHANGED",z.outputs[0]?.source_controls[0].display_name)
			} else { 	
				const zone =(rheos_zones.get(z))
				if (zone?.outputs.filter(op => op && get_pid(get_output_name(op))).length >1){
					const lead_player_pid = get_pid(get_output_name(zone.outputs[0]))
					const group = (rheos_groups.get(lead_player_pid))
					if (group?.gid) {
						await group_enqueue(lead_player_pid)
					}
				} 
				rheos_zones.delete(zone?.zone_id || z)	
			}
		}
		resolve()
	}).catch(err => console.error("-> ",new Date().toLocaleString(),"RHEOS: ⚠ ERROR UPDATING ZONES",err))
}
async function write_meta(player,why){
	if (player.mode == "ART" || player.mode == "META"){		
		if (why === "NEXT" && player?.next?.length){
			player.now_playing = player.next 
		}
		log && console.log("<- ",new Date().toLocaleString(),"RHEOS: WRITING META:",why,player.name,player.now_playing?.one_line.line1)
 		const now_playing =  player.now_playing 
		const duration =  (player.duration || player.now_playing?.length) *1000
	    await fs.writeFile(
			"./UPnP/"+player.udn,
			((player.mode == "ART" || player.mode == "META") ? now_playing?.three_line?.line1 : " " ) + "\n" 
			+ ((player.mode == "ART" || player.mode == "META") ? now_playing?.three_line?.line2 : " " ) + "\n" 
			+ ((player.mode == "ART" || player.mode == "META") ? ("RHEOS: " + now_playing?.three_line?.line3) : " ")  + "\n"
			+ duration + "\n"
			+ (1000).toString()  + "\n"
			+ (player.mode == "ART" ? now_playing?.image_key : ""),  {
				encoding: "utf8",
				flag: "w",
				mode: 0o666
			 }
			)
	} else {
		await fs.writeFile("./UPnP/"+player.udn,player.mode =="OFF" ? " " : "RHEOS : "+ player.name,  {
			encoding: "utf8",
			flag: "w",
			mode: 0o666
		  })
	}   
}
async function update_player_volume(op,player){
	clearInterval(player.force_play)
	if (!op?.volume || !player?.volume ){return}
	let {is_muted,value} = op.volume
	let {mute,level} = player?.volume 
	if ( level !== value) {
		player.volume.level = value
		await heos_command("player", "set_volume", { pid: player?.pid, level: value }).catch(err => console.error(new Date().toLocaleString(),err))
	}
	if ((mute == 'off' == is_muted  )) {
		player.volume.mute = is_muted? "on" : "off"
	    await heos_command("player", "set_mute", { pid: player?.pid, state: is_muted ? "on": "off"}).catch(err => console.error(new Date().toLocaleString(),err))
	}
	return
}
async function update_avr_volume(player,mode,value){  
	clearInterval(player.force_play)
	if (mode == 'relative'){
		await heos_command("player", value == 1 ? "volume_up" : "volume_down", { pid: player?.pid, step: 1 }).catch(err => console.error(new Date().toLocaleString(),err))
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
		await heos_command("player", "toggle_mute",{ pid: player?.pid}).catch(err => console.error(new Date().toLocaleString(),err))
        let zone = (services.svc_transport.zone_by_output_id(player.output))
		for (let o of zone.outputs){
            if (get_output_name(o).includes("​")){
				services.svc_transport.mute(o,o.volume.is_muted ? 'unmute' : 'mute')
			}
		}	
	} 
	return
}
async function set_fixed_group(players){
	let max = 0
	if (! rheos_players){return 0}
	for (let player of players){
		if (rheos_players.get(player.pid)){
			fixed_players.add(player.pid)
			let {volume:{level}} =rheos_players.get(player.pid)
			if(max < level){max = level}
		}	
	}
	return (max)
}
async function heos_command(commandGroup, command, attributes = {}, timer = 5000) {
	log && console.log("-> ",new Date().toLocaleString(),"RHEOS: REQUEST:",commandGroup, command, attributes)
	if (!rheos.connection) {
		console.error(new Date().toLocaleString(),"⚠ NO CONNECTION")
		return
	}
	typeof attributes === "object" || ((timer = attributes), (attributes = {}))
	return new Promise(function (resolve, reject) {
		setTimeout(() => {resolve(`Heos command timed out: ${command} ${timer}`) }, timer)
		commandGroup !== "event" && rheos.connection[0].write(commandGroup, command, attributes)
		rheos.connection[0].once({ commandGroup: commandGroup, command: command, attributes }, (res) => {
			log && console.log("<- ",new Date().toLocaleString(),"RHEOS: COMPLETE:",res.heos.message.unparsed === "" || (JSON.stringify(res.heos.message.parsed || res.heos.message.unparsed)))
			res.parsed = res.heos.message.parsed
			res.result = res.heos.result
			if (res.heos.message.unparsed.includes("under process")) {
				rheos.connection[0].once({ commandGroup: commandGroup, command: command, attributes }, (res) => {
				resolve(res)
			})} 
			else if (res.heos.message.unparsed.includes("Processing previous command")) {
				resolve(res)
			} 
			else if (res.heos.result === "success") {
				resolve(res)
			}
			else {
				reject(res)	
			}		
		})
	}).catch((err)=> log && console.warn("HEOS COMMAND ERROR",err))
}
async function set_player_resolution(player){
	log && console.log("-> ",new Date().toLocaleString(),"RHEOS: SETTING PLAYER RESOLUTION",player.name,player.resolution)
	let device = {} 
	device.udn = player.udn
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
			device.mode = "thru"
			device.sample_rate = '192000'
		}
		break
		case  ( "LOW" ) : {
			device.enabled = '1'
			device.mode = "thru"
			device.sample_rate = '48000'
		}
		break
		default : {
			device.enabled = '1'
			device.mode = ("flc:0,r:-48000,s:16").toString().concat(rheos.mysettings.flow ? ",flow" : "")
			device.sample_rate = '192000'
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
			device.send_coverart = "0"
		}
		break
		case  ( "ART" ) : {
			device.flow  = "0"
			device.send_metadata = "1"
			device.send_coverart = "1"
		}
		break
		default : {
			device.flow  = "1"
			device.send_metadata = "1"
			device.send_coverart = "0"
		}
	}
	let template = 	`<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
		<squeeze2upnp>
		<common>
			<enabled>0</enabled>
			<L24_format>2</L24_format>
			<roon_mode>1</roon_mode>
			<codecs>aac,ogg,flc,alc,pcm,mp3</codecs>
			<forced_mimetypes>audio/mpeg,audio/vnd.dlna.adts,audio/mp4,audio/x-ms-wma,application/ogg,audio/x-flac</forced_mimetypes>
			<raw_audio_format>raw,wav,aif</raw_audio_format>
			<streambuf_size>${rheos.mysettings.streambuf_size}</streambuf_size>
			<output_size>${rheos.mysettings.output_size}</output_size>
			<stream_length>${rheos.mysettings.stream_length}</stream_length>
			<seek_after_pause>${rheos.mysettings.seek_after_pause}</seek_after_pause>
			<volume_on_play>${rheos.mysettings.volume_on_play}</volume_on_play>
			<flac_header>${rheos.mysettings.flac_header}</flac_header>
			<accept_nexturi>${rheos.mysettings.accept_nexturi}</accept_nexturi>
			<next_delay>${rheos.mysettings.next_delay}</next_delay>
			<keep_alive>${rheos.mysettings.keep_alive}</keep_alive>
			<cache>${rheos.mysettings.cache}</cache>
			<log_limit>${rheos.mysettings.log_limit}</log_limit>
		</common>
		<device>
			<enabled>1</enabled>
			<send_metadata>${device.send_metadata}</send_metadata>
			<send_coverart>${device.send_coverart}</send_coverart>
			<flow>${device.flow}</flow>
			<udn>${player.udn}</udn>
			<friendly_name>${device.friendly_name}</friendly_name>
			<mode>${device.mode}</mode>
			<sample_rate>${device.sample_rate}</sample_rate>
		</device>
		</squeeze2upnp>`
	await fs.writeFile("./UPnP/Profiles/" + (player.name) + ".xml", template).catch(()=>{console.error(new Date().toLocaleString(),"⚠ Failed to create template for "+device.name[0])})
	const saved_player = rheos.myplayers.find(o => o.pid == player.pid)
	if (saved_player){
		saved_player.resolution = player.resolution
		saved_player.mode = player.mode
	}
	roon.save_config("players",[...rheos_players.values()].map((o) => {let {gid,Z2,PWR,volume,output,zone,state,status,group,now_playing,position,duration,rheos,next, ...p} = o;return(p)}));
}
async function start_listening() {
setInterval(()=> {!rheos.discovery && roon.paired && update_status(false,false)},10000)
await heos_command("system", "prettify_json_response", { enable: "on" }).catch(err => console.error(new Date().toLocaleString(),"⚠ Failed to set responses"))
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
			//await fs.chmod(fixed ? './UPnP/Bin/squeezelite/squeezelite-x86-64':'./UPnP/Bin/RHEOS-linux', 0o555)
			//return(fixed ? './UPnP/Bin/squeezelite/squeezelite-x86-64':'./UPnP/Bin/RHEOS-linux')
		} else if (os.arch() === 'ia32'){
			await fs.chmod(fixed ?'./UPnP/Bin/squeezelite/squeezelite-i386':'./UPnP/Bin/RHEOS-x86', 0o555)
			return(fixed ? './UPnP/Bin/squeezelite/squeezelite-i386' :'./UPnP/Bin/RHEOS-x86')
		} else {
			console.error(new Date().toLocaleString(),"⚠ UNSUPPORTED ARCHITECTURE  - ABORTING",os)
			process.exit(1)
		}
		} catch {
			console.error(new Date().toLocaleString(),"⚠ UNABLE TO LOAD LINUX BINARIES - ABORTING",os)
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
          	console.error(new Date().toLocaleString(),"⚠ UNABLE TO LOAD MAC BINARIES - ABORTING")
		  	process.exit(1)
		}
	}
	else {
		console.error(new Date().toLocaleString(),"⚠ THIS OPERATING SYSTEM IS NOT SUPPORTED");
	 	process.exit(1)
	}
}
async function group_enqueue(group) {
	Array.isArray(group) && (group = group.filter(o => o))
	if (group) {
		return new Promise(async (resolve, reject) => {
		const group_sums = group_buffer.map(o => sum_array(o.group))
		if (group_sums.findIndex(o => o === sum_array(group)) == -1){
			group_buffer.push({ group, resolve, reject })
			group_dequeue().catch((err)=>{log && console.error(new Date().toLocaleString(),"Deque error",err)})	
		} 
		})
	}
	return
}	
async function group_dequeue(timer = 10000) {
	if (rheos.working || !group_buffer.length) { 
		return }
	const item = group_buffer[0]
	if (!item) {
		return
	}
	rheos.working = true
	await heos_command("group", "set_group", { pid: item?.group?.toString() },timer).catch((err) => {console.error(sum_array(item.group));item.resolve(err); rheos.working = false; group_dequeue() })
	item.group.length == 1 && rheos_groups.delete(item?.group?.toString() )
	rheos.working = false 
	group_buffer.shift()
	item.resolve()
	await group_dequeue()
	return
}
async function update_heos_groups() {
return new Promise(async function (resolve) {
	let old_groups = [...rheos_groups.keys()]
	rheos_groups.clear()
	for (let p of rheos_players){
		delete(p[1].gid)
	}
	const res = await heos_command("group", "get_groups",10000).catch(err => console.error(new Date().toLocaleString(),err))
	if (res?.payload?.length) {
		for (const group of res.payload) {
			group.sum_group = sum_array(group.players.map(player => player.pid))
			for await (let player of group.players){
				let p = rheos_players.get(player.pid)
				p && (p.gid = group.gid)
				try{
					if (p.pid !== p.gid && player.udn){	
						await fs.writeFile("./UPnP/"+player.udn)	
					}	
				} catch {
					console.error(new Date().toLocaleString(),"RHEOS: WARNING ⚠ FAILED TO ERASE GROUPED PLAYER METADATA")
				}			
			}
			rheos_groups.set(group.gid, group)	;
		}
		const remove = old_groups.filter(group => !rheos_groups.has(group))
		for (let group of remove){
			rheos_groups.delete(group.gid)
		}
	} else {
		const remove = old_groups
		for (let group of remove){
			services.svc_transport.ungroup_outputs(services.svc_transport.zone_by_output_id(rheos_players.get(group)?.output)?.outputs)
		}
	}
	await get_all_groups()
	resolve()
	}).catch(err => console.error(new Date().toLocaleString(),err))
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
		core_paired: async function (core) {
			console.log(new Date().toLocaleString()+ " ROON PAIRED ",roon.extension_reginfo.extension_id)
			console.log("ROON SERVER IP ADDRESS",roon.paired_core?.moo?.transport?.host)
			exec("pkill -f -9 UPnP")
			exec("pkill -f -9 squeezelite")
			roon.paired = true
			rheos.mysettings.host_ip =  roon.paired_core?.moo?.transport?.host  
			await set_server(rheos.mysettings.host_ip )
			await start_heos().catch((err) => {console.error(new Date().toLocaleString(),"⚠ Error Starting Heos",err);reject()})
			rheos.listeners || 	add_listeners().catch(err => console.error(new Date().toLocaleString(),"⚠ Error Adding Listeners",err => {console.error(rheos.connection),reject()}))
			services.svc_transport = core.services.RoonApiTransport
			services.svc_transport.subscribe_outputs(async function (cmd, data) {		
				switch (cmd){
					case "Subscribed" : 
						for await (const o of data.outputs) {
							if (Array.isArray(o?.source_controls)){
								Array.isArray(data.outputs) &&  await update_outputs(data.outputs,true)
								let player =  get_player_by_name(get_output_name(o));
								if (player){
									player && (player.output = o.output_id)
									o.player = player
									player && rheos_players.set(player.pid,player)
								}
							}
						}
					break		
					case "Changed" : {
						Array.isArray(data.outputs_changed) && await update_outputs(data.outputs_changed,false)
						Array.isArray(data.outputs_added) &&  await update_outputs(data.outputs_added,true)
						if (Array.isArray(data.outputs_removed)) {
							await update_outputs(data.outputs_removed,false)
						}
					}
					break
					case "NetworkError" : {console.error(new Date().toLocaleString(),"RHEOS: ⚠ ERROR: OUTPUT NETWORK ERROR",cmd)
					}
					break
					default: console.error(new Date().toLocaleString(),"RHEOS: ⚠ ERROR: UNKNOWN OUTPUT ERROR",cmd)	
				}
			})
			services.svc_transport.subscribe_zones(async function (cmd, data) {
				data?.zones_seek_changed && data.zones_seek_changed.forEach( o  =>{
					const z = rheos_zones.get(o)
					if (z){
						z.queue_time_remaining = o.queue_time_remaining
						z.seek_position = o.seek_position
					}
				})
				switch(cmd){
					case "Subscribed" : 
						for await (const z of data?.zones) {
							if (z.outputs[0].source_controls[0].display_name.includes ("RHEOS")){
								log && console.log("-> ",new Date().toLocaleString(),"RHEOS: SUBSCRIBED: PLAYER", z.display_name)
								get_player_by_name(get_output_name(z.outputs[0])) &&	rheos_zones.set(z.zone_id, z)  
							    services.svc_transport.subscribe_queue(z,null,(cmd,data)=>update_queue(cmd,data,z))	
							}
						}			
					case "Changed" : {	
					    if (Array.isArray(data.zones_added)){
							for await (const z of data.zones_added) {
								if (z.outputs[0].source_controls[0].display_name.includes ("RHEOS")){
									get_player_by_name(get_output_name(z.outputs[0])) &&	rheos_zones.set(z.zone_id, z)  	
									services.svc_transport.subscribe_queue(z,null,(cmd,data)=>update_queue(cmd,data,z))
								} 			
							}	
							update_zones(data.zones_added);
						}
						if (Array.isArray(data.zones_changed)){
							for await (const z of data.zones_changed) {	
								if (z.outputs[0] && z.outputs[0].source_controls[0].display_name.includes ("RHEOS")){
									services.svc_transport.subscribe_queue(z,null,(cmd,data)=>update_queue(cmd,data,z))	
								}			
							}	
							update_zones(data.zones_changed);
						}
						Array.isArray(data.zones_removed) && update_zones(data.zones_removed);	
						Array.isArray(data.zones_seek_changed) && update_position(data.zones_seek_changed)
					}	
					break
					case "NetworkError" : {
						console.error(new Date().toLocaleString(),'RHEOS: ⚠',"ERROR: ZONE NETWORK ERROR ",cmd)
						exec("pkill -f -9 UPnP")
						exec("pkill -f -9 squeezelite")
					}
					break
					default: console.error(new Date().toLocaleString(),'RHEOS: ⚠',"ERROR: ZONE UNKNOWN ERROR",cmd)
				}
			})
		},
		core_unpaired: async function (core) {
			console.error(new Date().toLocaleString(),"RHEOS: WARNING ⚠ CORE UNPAIRED")
            roon.paired = false
			core = undefined
		},
		onclose: async function (core) {
			console.error(new Date().toLocaleString(),"⚠ RHEOS: WARNING ⚠ CORE CLOSED")
            roon.paired = false
			core = undefined
		}
		})
		if (roon){
			resolve (roon)
		} else {
			console.error(new Date().toLocaleString(),"ERROR ⚠ NO ROON API FOUND PLEASE CHECK YOUR ROON SERVER IS SWITCHED ON AND ACCESSIBLE AND TRY AGAIN");
			reject
		}
	})
}
async function update_queue(cmd,data,zone){
	if (zone && cmd == "Subscribed"){
		const player = [...rheos_players.values()].find(p=>(!p.gid || (p.gid == p.pid)) && p.zone == zone.zone_id)
		zone = await(update_zone(zone?.zone_id)).catch(
			()=>{console.log("ZONE NOT FOUND")}
		)
		if (zone.state == 'playing'&& zone?.now_playing && player && (!player?.gid || (player.pid == player.gid))){		
			if (player.mode !== "OFF"){
			 	if(zone.now_playing?.seek_position === null ){
					log && console.log("-> ",new Date().toLocaleString(),"RHEOS: SUBSCRIBED: TRACK INFO CHANGED",zone?.display_name,zone.state,zone.now_playing?.seek_position,zone.now_playing?.one_line.line1)	
					log && console.log("-> ",new Date().toLocaleString(),"RHEOS: SUBSCRIBED: NOW PLAYING",data.items[0].one_line.line1)
					log && console.log("-> ",new Date().toLocaleString(),"RHEOS: SUBSCRIBED: PLAYING NEXT",data.items[1]?.one_line?.line1 || " - NOT DEFINED")	
					player.now_playing = data.items[0]  
					player.next = data.items[1]
					player.duration = data.items[0]?.length 
					player.position =  0			
					await write_meta(player,"SUBSCRIBED")
					if (zone.state == 'playing' && zone.is_seek_allowed){ 
						setImmediate(()=>{
							player.is_forcing_reload = true
							log && console.log("-> ",new Date().toLocaleString(),"RHEOS: FORCE QUEUE RELOAD")
							services.svc_transport.seek(zone,'absolute',1,(err)=> {
								err ?  
								console.warn("-> ",new Date().toLocaleString(),"RHEOS:","⚠ WARNING: QUEUE RELOAD FAILED",err)
								:
								log && console.log("-> ",new Date().toLocaleString(),"RHEOS: QUEUE RELOAD SUCCESS",zone.display_name)
								player.position = 1
								player.now_playing = zone.now_playing
								rheos_players.set(player.pid,player)
							})
						})	
					} else if (zone.state == 'playing'){
						log && console.warn("-> ",new Date().toLocaleString(),"RHEOS: ⚠ WARNING: FORCE QUEUE NOT READY")
						update_queue(cmd,data,zone)
					} 
					
				}	
			}
		rheos_players.set(player.pid,player)			
		} 
	}		
}
async function update_position(zones){
	for await (const o of zones){	
		const _player = [...rheos_players.values()].find(p=>(!p.gid || (p.gid == p.pid)) && p.zone == o.zone_id)
		if (!o.zone_id || !_player?.zone ){continue} 
		const player = rheos_players.get(_player.pid)
		const zone = await update_zone(player.zone)
		if (!zone?.now_playing?.seek_position ){continue}
		
		if (player?.rheos  && player?.mode !== "FLOW" && player?.mode !== "OFF"){
		log && console.log("-> ",new Date().toLocaleString(),"RHEOS:",zone.state.toUpperCase()+":",player.name, player.is_forcing_reload || false ,zone.now_playing.length, zone.now_playing.seek_position )	
			if (zone.state == 'playing'  && !player.is_forcing_reload && ( zone.now_playing.length - zone.now_playing.seek_position < 2) ){
				player.position = 1
				player.is_forcing_reload = true
				player.need_meta = true
				rheos_players.set(player.pid,player)
				await write_meta(player,"NEXT",player.next)
				setImmediate(async ()=>{
					log && console.log("-> ",new Date().toLocaleString(),"RHEOS: FORCE NEXT",zone.now_playing.seek_position > 5,zone.is_next_allowed,zone.now_playing?.seek_position)
					zone.now_playing.seek_position > 5 && zone.is_next_allowed && services.svc_transport.control(zone,'next',(err)=> {
						err ?  
						console.warn("-> ",new Date().toLocaleString(),"RHEOS:","⚠ WARNING: FORCE NEXT FAILED",err)
						:
						log && console.log("-> ",new Date().toLocaleString(),"RHEOS: RELOAD NEXT SUCCESS",zone.display_name)
					})
				})
				log && console.log("-> ",new Date().toLocaleString(),"RHEOS: FORCING RELOAD",player.now_playing?.length,zone.now_playing?.seek_position, zone.is_seek_allowed )	
			} else if (zone.state == 'playing'  ){
				clearInterval(player.force_play)
				player.position = zone.now_playing.seek_position
				if (zone.now_playing.seek_position > 1) {
					player.is_forcing_reload = false
				}
				player.force_play = force_play(zone,10000,player.pid)
				const res = await heos_command("player", "get_play_state",{pid : player.pid})
				if (res.parsed?.state !== "play" && zone.now_playing.one_line.line1.startsWith(player.payload?.song)){
					await heos_command("player", "set_play_state",{pid : player.pid, state : "play"})
			   }
			} else if (zone.is_play_allowed && player.state == 'play'){
				services.svc_transport.control(zone.zone_id,"play")		
			} else {
				console.log(zone)
			}
		} 
		if (zone.now_playing?.seek_position >2 && player.now_playing?.one_line?.line1 == zone.now_playing?.three_line?.line1  && (Math.abs(zone.now_playing?.seek_position - player.position) > 5)){	
				log && console.log("-> ",new Date().toLocaleString(),"RHEOS: JUMPING",player.position,zone.seek_position,zone.now_playing.seek_position)
				player.position = zone.now_playing?.seek_position || 0
				player.duration = zone.now_playing.length - o.seek_position
				player.need_meta = true
				rheos_players.set(player.pid,player)
				await write_meta(player,"JUMP")
				zone.is_seek_allowed && services.svc_transport.seek(zone.zone_id,'absolute',zone.seek_position || 1,(err)=> {err && console.error("-> ",new Date().toLocaleString(),"RHEOS: ⚠ WARNING:",player?.name,err)})
		} 
		if (player.need_meta && player.now_playing?.length && ((player.now_playing?.length - zone.seek_position) <= 5 )){
				write_meta(player,"NEXT",player.next)
				player.need_meta = false
		}
	rheos_players.set(player.pid,player)
	}		  
}
async function update_status(message = "",warning = false){
	let RheosStatus = rheos_players.size + " HEOS Players on " + rheos.system_info[2] +" "+ rheos.system_info [3]+" "+ rheos.system_info [4] + ' at ' + rheos.system_info[0] + '  for ' + get_elapsed_time(start_time) + '\n'
	for (let zone of [...rheos_zones.values()].filter(zone => (zone?.outputs && get_player_by_name(get_output_name(zone.outputs[0])) && ! get_output_name(zone.outputs[0]).includes("🔗") && zone.state ==="playing") )) {	
		RheosStatus = RheosStatus + (zone.outputs.length == 1 ?"🎵 ":"🎶  ") + (zone.fixed?.zone?.output || zone.display_name) + "\t ▶ \t" + zone.now_playing?.one_line?.line1 + "\n"
	}
	message && (RheosStatus = RheosStatus + "\n" + message)
	services.svc_status.set_status(RheosStatus,warning)
}
async function set_server(ip) {
	try {
		console.log("SETTING SERVER: ",ip + ":9330")
	  await fs.writeFile('./UPnP/server', ip + ":9330");
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
async function update_zone(zone_id){
	if (zone_id){
		return new Promise(function(resolve, reject) {
			let data = services.svc_transport.zone_by_zone_id(zone_id)
			if (! data) {
				reject("NO DATA RETURNED")
			} else {
				resolve(data)
			}
		}) 
	}
}
function force_play(zone,freq,pid){
	return(
		setInterval(async (z)=>{
			if (roon.paired){	
				console.log("INTERVAL ",z.zone_id)
				zone = await update_zone(z.zone_id)
				const player = rheos_players.get(pid)
				log && console.log("-> ",new Date().toLocaleString(),"RHEOS: ⚠ WARNING: FORCE PLAY TRIGGERED AS NO PROGRESS",zone?.display_name, freq,zone.now_playing?.three_line.line1,player.now_playing?.three_line.line1)
				if (zone?.is_play_allowed ){
					services.svc_transport.control(zone.zone_id,'play',(err)=> {err ?
						console.error(new Date().toLocaleString(),"RHEOS: ⚠ ERROR: UNABLE TO FORCE PLAY")
						: 
						log && console.log("-> ",new Date().toLocaleString(),"RHEOS: SUCCESS: FORCED PLAY") 
					    clearInterval(player.force_play)
					})
				} else if (zone?.is_seek_allowed){
					services.svc_transport.seek(zone.zone_id,'absolute',1,(err)=> {err ?
						console.error(new Date().toLocaleString(),"RHEOS: ⚠ ERROR: UNABLE TO SEEK TRACK START")
						:
						log && console.log("-> ",new Date().toLocaleString(),"RHEOS: SUCCESS: SEEK TRACK START") 
						clearInterval(player.force_play)
					})
				} else {
					console.warn(new Date().toLocaleString(),"RHEOS: ⚠ WARNING: FORCE PLAY FAILED",zone.display_name,zone.state,zone.is_next_allowed,zone.is_previous_allowed)
				}
			}	
		},freq,zone)
	)	
} 	
function makelayout(settings) {
	const players = [...rheos_players.values()],
	ips = players.map(player => new Object({ "title": player.model + ' (' + player.name + ') ' + ' : ' + player.ip, "value": player.ip }))
	ips.push({ title: "No Default Connection", value: 0})
	let l = {values: settings,layout: [],has_error: false}
	l.layout.push(ips.length > 1 ? { type: "dropdown", title: "Default Heos Connection", values: ips, setting: "default_player_ip" }: { type: "string", title: "Default Heos Player IP Address", maxlength: 15, setting: "default_player_ip" })
	l.layout.push({ title: "Enable AVR Zone Control ", type: "dropdown", setting: 'avr_control', values : [{title: "ON", value : 1},{title : "OFF", value :0}]})
	l.layout.push({ title: "Enable Fixed HEOS Groups ", type: "dropdown", setting: 'fixed_control', values : [{title: "ON", value : 1},{title : "OFF", value :0}]})
	l.layout.push({ title: "Enable Logging ", type: "dropdown", setting: 'log', values : [{title: "ON", value : true},{title : "OFF", value :false}]})
	if (players.length) {
		let _players_status = { type: "group", title: "PLAYER AUDIO RESOLUTION", subtitle: "Set player resolution", collapsable: true, items: [] }
		for (let player of players){
			if (player.name) {
				_players_status.items.push({title: ('◉ ') + player.name.toUpperCase(),type: "dropdown",
				values: [{ title: "Hi-Resolution", value: "HR" }, { title: "CD Quality", value: "CD" },{ title: "Pass Through", value: "THRU"},{title : "Pass Through Low Res" , value : "LOW"}],
				setting: "P"+player.pid
				})
			}
		}
		l.layout.push(_players_status)
		let _players_mode = { type: "group", title: "PLAYER DISPLAY MODE", subtitle: "Set player display options", collapsable: true, items: [] }
		for (let player of players){
			if (player.name ) {
				_players_mode.items.push({title: ('◉ ') + player.name.toUpperCase(),type: "dropdown",
				values: [{ title: "Off", value: "OFF" },{ title: "Flow Mode", value: "FLOW" }, { title: "Meta Data Only", value: "META"}, {title: "Meta and Album Art", value: "ART"}],
				setting: "M"+player.pid
				})
			}
		}
		l.layout.push(_players_mode)
	}
	let _avrs = { type: "group", title: "AUTO PLAY", subtitle: "Set for devices with power ON/OFF", collapsable: true, items: [] };
	for (let player of rheos_players) {
		if (Array.isArray(player[1].PWR)) {
			let values = [
				{title : "OFF", value :"-1"},
				{title : "No-Delay", value :"0"}]
				for (let i = 0; i < 21; i++) {
					values.push ({title : i, value : i})
				}
			_avrs.items.push({title: player[1].name, subtitle: "Set delay (secs)",type: "dropdown",values: values, setting: "A"+player[1].pid})
		}
	}
	l.layout.push(_avrs)
	if (rheos.mysettings.fixed_control){
		const _fixed_groups = { type: "group", title: "FIXED GROUPS", subtitle: "Create fixed groups of players", collapsable: true, items: [] };
		for (let group of all_groups.entries()) {
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
		{ title: "● Keep Alive", type: "integer", setting: 'keep_alive', min: -1, max: 120 },
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
	 	l.has_error && console.error("-> ",new Date().toLocaleString(),"⚠  RHEOS ERROR: INVALID IP ENTRY",l.values.host_ip)
	 	return (l)
}
function monitor_avr_status() {
	rheos.monitor = setTimeout(async () => {
		let avrs = [...rheos_players.values()].filter(p => p.type === "AVR")
		for await (const avr of avrs){
			!rheos.block_avr_update && rheos.mysettings.avr_control && update_avr_status(avr).catch(() => {console.error("⚠ ERROR MONITORING AVR STATUS")})
		}
	  	monitor_avr_status();
	}, 2000)
}
function get_zone_group_value(zone_id){
	let zone = zone_id
	if (typeof(zone_id) !== 'object'){
		zone = rheos_zones.get(zone_id) || rheos_zones.get(zone_id?.zone_id) || false
	}
	if (!zone) {return}
	return( sum_array(zone.outputs.map(o => get_pid(get_output_name(o))))) 
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
function get_output_name(output){
	if (output.source_controls[0]?.display_name.includes("RHEOS")){
		return (output.source_controls[0]?.display_name.substring(0, output.source_controls[0]?.display_name.indexOf("(RHEOS")).trim())
	} else if (output.source_controls[0]?.display_name.includes('​')){
		return (output.source_controls[0]?.display_name)
	} else {
		return ("")
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
		console.log("\r\nRHEOS IS SHUTTING DOWN")
		console.log(Object.keys(rheos.processes).length)
		exec("pkill -f -9 UPnP")
		exec("pkill -f -9 squeezelite")
		process.exit(0);	
    };
    process.on('SIGTERM', handle);
    process.on('SIGINT', handle);
}
function get_player_by_name(name) {
	return [...rheos_players.values()].find((player) => player?.name?.trim().toLowerCase() === name?.trim().toLowerCase())
}
function get_player_by_zone(zone) {
	return ([...rheos_players.values()].find(player => player?.zone ===zone))
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
function delay(time) {
    return new Promise(resolve => setTimeout(resolve, time))
}
