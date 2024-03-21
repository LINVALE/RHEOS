const version = "0.9.3-06"
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
var log = process.argv.includes("-l")||process.argv.includes("-log") 
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
const blocked_players = new Set()
const group_pending =[]
const avr_zone_controls = {}
const avr_volume_controls = {}
const rheos_connect = RheosConnect.Telnet
let squeezelite ="squeezelite"
const sound_modes = ["MSSTEREO","MSDIRECT","MSPURE DIRECT","MSMCH STEREO","MSVIRTUAL"]
suppressExperimentalWarnings(process)
init_signal_handlers()
exec("pkill -f -9 UPnP")
exec("pkill -f -9 squeezelite")
await start_up().catch((err) => console.error("⚠ ERROR STARTING UP",err))
async function start_up(){
	return new Promise (async function (resolve,reject)	{
	await start_roon().catch(err => console.error(new Date().toLocaleString(),"⚠ Error Starting Roon",err => {throw error(err),reject()}))
	let c = spawn("squeezelite")
		c.on('error', async function(err) {
		log && console.error(new Date().toLocaleString(),'SQUEEZELITE NOT INSTALLED : LOADING BINARIES');
		squeezelite = await choose_binary("squeezelite",true).catch(err => console.error(new Date().toLocaleString(),"⚠ Error Loading Squeezelite Binaries",err => {console.error(err),reject()}))
	})
	console.log("SYSTEM INFORMATION:",rheos.system_info.toString(),"Version :",roon.extension_reginfo.display_version)
	log = rheos.mysettings.log
	await start_heos().catch((err) => {console.error(new Date().toLocaleString(),"⚠ Error Starting Heos",err);reject()})
	await start_listening()
	await update_heos_groups().catch( err => {console.error(new Date().toLocaleString(),"⚠ Error Updating HEOS groups",err);reject()})
	await create_zone_controls().catch( err => {console.error(new Date().toLocaleString(),"⚠ Error Creating Zone Controls",err);reject()})
	await create_fixed_group_control().catch( err => {console.error(new Date().toLocaleString(),"⚠ Error Creating Fixed Groups",err);reject()})
	rheos.mysettings.fixed_control && await load_fixed_groups().catch( err => {console.error(new Date().toLocaleString(),"⚠ Error Loading Fixed Groups",err);reject()})
	Object.entries(rheos.mysettings).filter(o => isNaN(o[0])).forEach(o => console.log("-> RHEOS: SETTING",to_title_case(o[0].padEnd(20 ,".")),o[1] ? (o[1] === true || o[1] === 1) ? "On" : o[1] : o[1]===0 ? "Off" : "Not Defined"))
	rheos.mysettings.avr_control && monitor_avr_status()
	resolve()
	}) .catch( err => {console.error(new Date().toLocaleString(),"⚠ Error Starting Up",err)})
}
async function add_listeners() {
	rheos.listeners = true
	rheos.connection[0].socket.setMaxListeners(32)
	rheos.connection[1].socket.setMaxListeners(32)
	rheos.connection[1].write("system", "register_for_change_events", { enable: "on" })
		.onClose(async (hadError) => {
			console.error(new Date().toLocaleString(),"⚠ Listeners closed", hadError)
			rheos.listeners = false
			await start_up().catch(err => { console.error(new Date().toLocaleString(),err) })
		})
		.onError((err) => {
			console.error(new Date().toLocaleString(),"⚠ HEOS REPORTS ERROR", err)})
		.on({ commandGroup: "event", command: "groups_changed" }, async (res) => {
			log && console.log("-> RHEOS: EVENT:",JSON.stringify(res))
			await update_heos_groups().catch(err => console.error(new Date().toLocaleString(),"⚠ Error Updating HEOS Groups",err))
			for (const group of [...rheos_groups.values()]) {
				let pending_index = group_pending.findIndex(g => g.group.gid == group.gid)
				const zone = services.svc_transport.zone_by_output_id(rheos_players.get(group.gid)?.output)
				if (pending_index >-1){
					group_pending[pending_index].status ="grouped"
						let int = setInterval((gid) => {
							const zone = services.svc_transport.zone_by_output_id(rheos_players.get(gid)?.output)
							log && console.log("-> RHEOS PENDING:",zone.display_name,zone.state,group_pending[pending_index].zone.display_name)
							if (zone.state !== "playing" && zone.state !== "loading"){
								services.svc_transport.control(zone,'play')
							}
							else if (zone.state == "playing" ) {
								group_pending.splice(pending_index,1)
								clearInterval(int)
							} 
						},1000,group.gid)
					
					 
				} else {
					const players =	group.players.sort((a, b) => {let fa = a.role == "leader" ? 0 : 1; let fb = b.role == "leader" ? 0 : 1; return fa - fb} )	
					const new_outputs= players?.map(player => rheos_players.get(player.pid)?.output).filter(Boolean) || []
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
			log && console.log("-> RHEOS: EVENT:",JSON.stringify(res))
		    await compare_players()
		})
		.on({ commandGroup: "event", command: "sources_changed" }, async (res) => {
			log && console.log("-> RHEOS: EVENT:",JSON.stringify(res))
		})
		.on({ commandGroup: "event", command: "player_state_changed" }, async (res) => {
			log && console.log("-> RHEOS: EVENT:",JSON.stringify(res))
			const {pid,state} = res.heos.message.parsed
			const player =  rheos_players.get(pid)
			const op = player?.output
			if (rheos_outputs.get(op) && (!player.gid || player.pid === player.gid) && !fixed_players.has(player.pid)){
				let zone = services.svc_transport.zone_by_output_id(op) 
				if (zone){
					if (state === "pause"  && (zone.is_pause_allowed )){
						services.svc_transport.control(zone,'pause')
					}
					if (state === "play"  && zone.is_play_allowed){
						services.svc_transport.control(zone,'play')
					}
					if (state === "stop" && zone.state === "paused"){
						services.svc_transport.control(zone,'stop')
					}
				}
			}
		})
		.on({ commandGroup: "event", command: "repeat_mode_changed" }, async (res) => {
			log && console.log("-> RHEOS: EVENT:",JSON.stringify(res))
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
			log && console.log("-> RHEOS: EVENT:",JSON.stringify(res))
			const {pid,shuffle} = res.heos.message.parsed
			const zone = services.svc_transport.zone_by_output_id(rheos_players.get(pid)?.output) 
			if (zone){
				services.svc_transport.change_settings(zone,{shuffle : shuffle == "on"  })
			}
		})
		.on({ commandGroup: "event", command: "player_playback_error" }, async (res) => {
			log && console.log("-> RHEOS: EVENT:",JSON.stringify(res))
			const op = rheos_players.get(res.heos.message.parsed.pid)?.output
			if (op && res.heos.message.parsed.error.includes("Unable to play media")){
				let zone  = services.svc_transport.zone_by_output_id(rheos_players.get(res.heos.message.parsed.pid)?.output)
				services.svc_transport.control(zone,'play')
			}
		})
		.on({ commandGroup: "event", command: "player_volume_changed" }, async (res) => {
			log && console.log("-> RHEOS: EVENT:",JSON.stringify(res))
			const { heos: { message: { parsed: { mute, level, pid } } } } = res, player = rheos_players.get(pid), output = rheos_outputs.get(player?.output)
			if (output && roon.paired ){
				if (level !== player?.volume?.level) {
					player.volume.level = level
					services.svc_transport.change_volume(output, 'absolute', level)
				}
				if (mute !== player.volume.mute) {
					player.volume.mute = mute
					services.svc_transport.mute(player.output, (mute == 'on' ? 'mute' : 'unmute'))		
				}
			} 
		})
}
async function start_heos(counter = 0) {
	if (counter == 10){ reject()} 
	return new Promise (async function (resolve,reject){
		process.setMaxListeners(32)
		if (!rheos.connection) {
			try {
				rheos.connection =   await Promise.all([HeosApi.connect(rheos.mysettings.default_player_ip),HeosApi.connect(rheos.mysettings.default_player_ip)])
				console.log("-> RHEOS: CONNECTED TO DEFAULT PLAYER IP",  rheos.mysettings.default_player_ip )
			} catch {
				console.log("-> RHEOS: CONNECTING TO DISCOVERED PLAYER")
				rheos.connection = await  Promise.all([HeosApi.discoverAndConnect({timeout:10000, address:rheos.system_info[0]}),HeosApi.discoverAndConnect({timeout:10000, address:rheos.system_info[0]})])  
			} 
		}
		rheos.connection[0].socket.setMaxListeners(32)
		rheos.connection[1].socket.setMaxListeners(32)
		let players = await get_players()
		if (Array.isArray(players)){
			await set_players(players)
			roon.save_config("settings",rheos.mysettings);
			roon.save_config("players",[...rheos_players.values()].map((o) => {let {Z2,PWR,volume,output,zone,state,status,group, ...p} = o;return(p)}));
			resolve	()
		} else {
			console.error("UNABLE TO EDISCOVER PLAYERS")
			reject (start_heos(counter ++))
		}		
	})
}
async function get_device_info(ip){
	if (!ip){return}
	const response = await fetch('http://' + ip + ':60006/upnp/desc/aios_device/aios_device.xml').catch(err => console.log(err))
	const body = await response.text().catch(err => console.log(err))
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
	console.table(removed, ["name", "pid", "model", "ip", "resolution","network","udn"]) 
	return
}
async function set_players(players){
	if (!Array.isArray(players) || !players.length){return}
	const added = []
	for await (let player of players) {
		if (player?.pid && typeof(player) === "object") {
			if (rheos.myplayers.find(p => p.pid == player.pid)) { 
				player.resolution = rheos.myplayers.find(p => p.pid == player.pid).resolution
				player.auto_play = rheos.myplayers.find(p => p.pid == player.pid)?.auto_play 
				player.network = player.network || rheos.myplayers.find(p => p.pid == player.pid)?.network 
			    player.ip = player.ip || rheos.myplayers.find(p => p.pid == player.pid)?.ip && console.error(new Date().toLocaleString(),"Unable to get current player ip")
			} else { 
				player.resolution = "CD" 
				player.auto_play = "OFF"	
			}
			const info = await get_device_info(player.ip).catch(()=>{console.error(new Date().toLocaleString(),"Unable to get player UDN")})
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
	 			await create_player(player).catch(()=>{console.error(new Date().toLocaleString(),"Failed to create player",player)})
			}
		}
 	}
	if (added.length){
		console.log("ADDED PLAYERS")
	 	console.table(added, ["name", "pid", "model", "ip", "resolution","network","udn"]) 
	}	 
	return
}
async function get_players() {
	return new Promise(function (resolve, reject) {
		if (!rheos.connection) {reject("AWAITING CONNECTION")}
		rheos.connection[1]
		.write("player", "get_players", {})
		.once({ commandGroup: 'player', command: 'get_players' }, (players) => {
			switch(true){
				case (players?.payload?.length > 0 && players?.payload.every((p)=> p?.pid)) : {
					log && console.log("GOT",players.payload.length,"PLAYERS",)
					resolve(players?.payload)
				}	
				break
				case (players.heos.result === "failed"):{
					console.error(new Date().toLocaleString(),"UNABLE TO GET PLAYERS",players)
					reject()
				}			
				break
				case (players.heos.message.unparsed == "command under process"):{
					rheos.connection[1]
					.once({ commandGroup: 'player', command: 'get_players' }, (players) => {
						resolve( players?.payload)}).catch(err => {console.error(err)
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
async function read_player_status(pid){
	const res = await heos_command("player", "get_play_state",{pid : pid})
	return(res.parsed?.state)
}
async function create_player(player) {
	log && console.log("-> RHEOS: CREATING",JSON.stringify(player))
	const app = await (choose_binary()).catch(err => console.error(new Date().toLocaleString(),"Failed to find binary",err))
	await set_player_resolution(player).catch(err =>{console.log(err)})
	rheos.processes[player.pid] = spawn(app,['-b', rheos.system_info[0], '-Z', '-M', player.name + " (RHEOS: "+player.model+")",'-x', './UPnP/Profiles/' + player.name + '.xml',(rheos.mysettings.upnp_ip && (',-s', rheos.mysettings.upnp_ip))],
	{ stdio: 'ignore' },rheos_players.set(player.pid,player))	
	return 
}
async function load_fixed_groups(){
	rheos.myfixed_groups.length &&
	rheos.myfixed_groups.forEach( async fg => {
		create_fixed_group(fg).catch(()=> {})
	})
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
	const fixed = Math.abs(group.sum_group).toString(16);
    const name = [... new Set(group.name.split("+"))]
	group.display_name = "🔗 " +name[0].trim()+" + " + (name.length -1)
	rheos.mysettings[group.sum_group.toString()]=[group.resolution]
	if (! fixed_groups.has(group.sum_group)){
		fixed_groups.set(group.sum_group,group)
		rheos.mysettings[group.sum_group.toString()]=[group.resolution]
		rheos.myfixed_groups.find( g => g.sum_group === group.sum_group) ||rheos.myfixed_groups.push(group)
	}
	if (! rheos.processes[fixed]){	
		const mac = "bb:bb:bb:"+ fixed.replace(/..\B/g, '$&:').slice(1,7)
		rheos.processes[fixed] = spawn(squeezelite,["-a","24","-r",group.resolution +" : 500","-M",group.display_name,"-m", mac,"-o","-","-p","99","-W","-v"])
	}
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
			let output = [...rheos_outputs.values()].find(o =>get_output_name(o) == rheos.myfixed_groups[index].display_name)
			if (output){
				fixed_groups.delete(sum_group)		
				delete rheos.mysettings[sum_group]
				services.svc_transport.ungroup_outputs([output])
				remove && rheos.myfixed_groups.splice(index,1)
				process.kill(Number(rheos.processes[Math.abs(sum_group).toString(16)].pid),'SIGKILL')
				delete rheos.processes[Math.abs(sum_group).toString(16)]
			}   
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
				rheos.mysettings[p.pid] = p.resolution
				rheos.mysettings["A"+p.pid] = p.auto_play
			})
			await get_all_groups()
			rheos.mysettings.upnp_ip = rheos.mysettings.upnp_ip || roon.paired_core?.moo?.transport?.host
			Array.isArray(rheos.myfixed_groups) && rheos.myfixed_groups.forEach(g => {rheos.mysettings[g.sum_group] = (g.resolution)})
			cb(makelayout(rheos.mysettings))
		},
		save_settings: async function (req, isdryrun, settings) {
			let l = makelayout(settings.values)
			if (!isdryrun && !l.has_error) {
				if (settings.values.clear_settings ) {
					exec("pkill -f -9 UPnP")
					settings.values = def.settings
					rheos.mysettings.clear_settings = 0
					rheos.system_info = [ip.address(), os.type(), os.hostname(), os.platform(), os.arch()]
					await start_heos()
					console.log("RESET TO DEFAULTS")
					update_status("Settings returned to defaults",true)
				} 
				if (settings.values.refresh_players) {
					let players = await get_players().catch(err => {console.error(new Date().toLocaleString(),"⚠ Error Getting Players",err, reject())})
					exec("pkill -f -9 UPnP")
					await set_players(players)
					console.log("REFRESHED PLAYERS")
					update_status("Players refreshed",true)
					settings.values.refresh_players = 0	
				}
				console.table([...rheos_players.values()], ["name", "pid", "model", "ip", "resolution","network","udn"]) 
				for await (let player of [...rheos_players.values()]){		
					if(player.resolution !== l.values[player.pid] ){
						player.resolution = l.values[player.pid] || "CD"
						rheos_players.set(player.pid,player)
						delete(settings[player.pid])
						if (rheos.processes[player.pid]?.pid){
							process.kill(rheos.processes[player.pid].pid,'SIGKILL')
						}
						
						await create_player(player).catch(()=>{console.error(new Date().toLocaleString(),"Failed to create player",JSON.stringify(player))})
						console.log("RESET PLAYER RESOLUTION")
						let x = console.table([player], ["name", "pid", "model", "ip", "resolution","network","udn"]) 
						update_status(`${player.name} set to ${player.resolution}`,false)
					}
					if (Array.isArray(player.PWR)){
						if (player.auto_play !== l.values["A"+player.pid]){
							player.auto_play =  l.values["A"+player.pid]
							rheos_players.set(player.pid,player)
							rheos.myplayers= [...rheos_players.values()]	
							delete (settings["A"+player.pid])
							update_status(`${player.name} autoplay delay set to ${player.auto_play} seconds`,false)
						}	
					}
				}
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
				} else{
				  	await unload_fixed_groups().catch(err => console.error(new Date().toLocaleString(),"⚠ Error Unloading Fixed Groups",(err) => {throw error(err),reject()}))
				}
				if (settings.values.avr_control){ 
					let avrs = [...rheos_players.values()].filter(player => player.type == "AVR")
					for (let avr of avrs){
						avr_volume_controls[avr.pid]?.update_state({	state: {
							volume_type:  "number"
						}})
					}
					monitor_avr_status()
				}else {
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
					default_player_ip,host_ip,streambuf_size,output_size,stream_length,seek_after_pause,volume_on_play,volume_feedback,accept_nexturi,flac_header,keep_alive,next_delay,send_coverart,send_metadata,flow,max_safe_vol,avr_control,fixed_control,log_limit,log,clear_settings,refresh_players,upnp_ip
			    }) => ({
					default_player_ip,host_ip,streambuf_size,output_size,stream_length,seek_after_pause,volume_on_play,volume_feedback,accept_nexturi,flac_header,keep_alive,next_delay,send_coverart,send_metadata,flow,max_safe_vol,avr_control,fixed_control,log_limit,log,clear_settings,refresh_players,upnp_ip
				})
				const selected = select(rheos.mysettings)
				const changed = select(settings.values)
				if (JSON.stringify(selected) !== JSON.stringify(changed)){
					update_status("UPDATING UPnP SETTINGS - PLEASE WAIT",false)
					roon.save_config("settings", changed)
					rheos.mysettings = changed
					log = changed.log
					exec("pkill -f -9 UPnP")
					set_players([...rheos_players.values()])
	                let s = "Updated settings"
					update_status(s,false) 
				}	
				if (selected.default_player_ip !== changed.default_player_ip) {
					setTimeout(()=>{
						delete rheos.connection
						start_heos()
					},3000)
					console.log("RESTARTING WITH CONNECTION TO ",settings.values.default_player_ip )
					update_status("Restarting With Connection to " + settings.values.default_player_ip,true)
				}
				roon.save_config("fixed_groups",rheos.myfixed_groups)
				roon.save_config("players",[...rheos_players.values()].map((o) => {let {gid,Z2,PWR,volume,output,zone,state,status,group, ...p} = o;return(p)}));	
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
		log &&console.log("<- AVR: REQUEST:",JSON.stringify(req.item))
		if (req) {
			log && console.log("-> AVR: COMPLETE:",(JSON.stringify(res,req)))
		}
		req && req.resolve(res)	
	}
	catch {
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
			if ((!player[1].model.includes("HEOS"))&&(!player[1].model.includes("Home"))){
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
		roon.save_config("players",[...rheos_players.values()].map((o) => {let {Z2,PWR,volume,output,zone,state,status,group, ...p} = o;return(p)}));   
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
		await create_avr_controls(avr).catch((err)=>{console.error(err)})
		avr.type = "AVR"
		avr.status = []	
		let sm = await control_avr(avr.ip,"MS?").catch((err)=>{console.error(new Date().toLocaleString(),"⚠ FAILED TO CONNECT",err)})
		avr.sound_mode = sm[0]
		return("AVR")						    
	} else { 
		avr.type = undefined;
		return(undefined)
	}
}
function monitor_avr_status() {
	rheos.monitor = setTimeout(async () => {
		let avrs = [...rheos_players.values()].filter(p => p.type === "AVR")
		for await (const avr of avrs){
			!rheos.block_avr_update && rheos.mysettings.avr_control && update_avr_status(avr).catch(() => {console.error("⚠ ERROR MONITORING AVR STATUS")})
		}
	  	monitor_avr_status();
	}, 5000)
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
						log && console.log("-> AVR: CONTROL",JSON.stringify(control))
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
	log && console.log("->AVR: ZONE IS ON",index === 0?  avr?.name + "​ Main​ Zone": avr?.name + "​ Zone​ 2")
	const hex = ((Math.abs(avr?.pid)+(index+1)).toString(16))
	if (! rheos.processes[hex]){
		const mac = "bb:bb:"+ hex.replace(/..\B/g, '$&:').slice(-11)
		rheos.processes[hex] = await spawn(squeezelite,["-M", index === 0?  avr?.name + "​ Main​ Zone": avr?.name + "​ Zone​ 2","-m", mac,"-o","-","-Z","192000"])
	}
	return	
}
async function create_avr_controls(player){	
	player = rheos_players.get(player.pid)
	if (player){
		for  (let index = 1; index < 3; index++) {
			switch (index) {
				case 1 :
					log && console.log("-> RHEOS: CREATING AVR CONTROL",  player?.name +   "​ Main​ Zone")
				break
				case 2 :
					log && console.log("-> RHEOS: CREATING AVR CONTROL",  player?.name +   "​ Zone​ 2")
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
					rheos.block_avr_update = false

				},
				set_mute: async function (req, mode	) {
					rheos.block_avr_update = true
					await update_avr_volume(this.state.player,mode)
				   	req.send_complete("Success");
					rheos.block_avr_update = false
			}
		}
		avr_volume_controls[player.pid] || (avr_volume_controls[player.pid] = services.svc_volume_control.new_device(volume_control))	
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
	}
	return 
}
async function update_control (name,ip,present){
	let present_mode_index = sound_modes.findIndex(sm => sm.includes(present.slice(name.length + 3).toUpperCase()))
	let next = (present_mode_index<sound_modes.length-1 ? 	sound_modes.at(present_mode_index+1):sound_modes.at(0))
	await control_avr( ip, next).catch(()=>{console.error("ERROR UPDATING SOUND MODE ",name,ip,next)})
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
									if (new_level>0 && new_level<= op.volume.soft_limit)
									{	
										heos_command("player", "set_volume", { pid: player?.pid, level:  new_level}).catch(err => console.error(new Date().toLocaleString(),err))
									}	
								}
							} else if(op.volume?.is_muted != old_op?.volume?.is_muted){
								{
									heos_command("group", "set_mute", { gid: fixed_group.gid, state: op.volume.is_muted ? "on" : "off" }).catch(err => console.error(new Date().toLocaleString(),err))
								}
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
					else if (player ) {  
						await update_player_volume(op,player)	
					}
					if (!old_op &&  op?.volume?.value == 100){
						if (op?.volume?.value == 100 || !op.volume.value ){
							services.svc_transport.change_volume(op,"absolute",0)	
						}
					}
					rheos_outputs.set(op.output_id,op)
				}	
			}
		}	
		resolve()
	}).catch(err => console.error(new Date().toLocaleString(),"⚠ ERROR UPDATING OUTPUTS",err))		
}				
async function update_zones(zones){
	return new Promise(async function (resolve) {
		for (const z of zones) {
			let fixed = {}
			let pending_index = -1
			if (z.outputs && ((z.outputs[0].source_controls[0].display_name.includes ("RHEOS") || z.outputs[0].source_controls[0].display_name.includes ("🔗")) || z.outputs[0].source_controls[0].display_name.includes ("​")) ){
				pending_index  = group_pending.findIndex(g => g.group.players.find(p => p.role == "leader")?.name == get_output_name(z.outputs[0])) 
				if (rheos.mysettings.fixed_control ){	
					fixed = ([...fixed_groups.values()].find(group => z.outputs.find(o => o.source_controls[0].display_name.includes ("🔗"))?.source_controls[0].display_name == group.display_name)) 
					if (fixed?.gid){ 
						fixed.state = z.state
						const index = group_pending.findIndex(z => z.group.gid === fixed.gid)
						if (z.outputs.length == 1){
							if (z.is_pause_allowed && index == -1){
								const max_vol = await set_fixed_group(fixed.players)
								services.svc_transport.change_volume( z.outputs[0],'absolute',max_vol,  
								services.svc_transport.transfer_zone( z,services.svc_transport.zone_by_output_id(rheos_players.get(fixed.gid)?.output)))         
								group_pending.push({zone : z , group : fixed, status : "transferring"})	
							}
						}
						if (z.outputs.length > 1 && index == -1 && (z?.state == 'paused' || (z?.state == "stopped" && z?.queue_items_remaining === 0))){
							const op = rheos_outputs.get(z.outputs[0].output_id)
							if (op){
								services.svc_transport.ungroup_outputs(z.outputs)
								fixed.players.forEach(p => fixed_players.delete(p.pid))	
							}
						}
					}
					if (pending_index >-1){
						const pending = group_pending[pending_index]
						if (pending.status == "transferring"){
							let zone_outputs = pending.group.players.sort((a, b) => {let fa = a.role == "leader" ? 0 : 1; let fb = b.role == "leader" ? 0 : 1; return fa - fb} ).map(player => rheos_outputs.get(rheos_players.get(player.pid)?.output))
							zone_outputs.push(pending.zone.outputs[0])
							zone_outputs = zone_outputs.filter(Boolean)
							pending.status="grouping" 
							services.svc_transport.group_outputs(zone_outputs)
						} 
					} 
				}
				const index =   (z.outputs.findIndex(o => o.source_controls[0].status == "standby"))				
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
						console.log("STANBY ZONE",z.outputs[index].source_controls[0]?.display_name)
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
				const old_zone =  rheos_zones.get(z?.zone_id)
				if (z.outputs.length > 1){
					const group = (rheos_groups.get(get_pid(get_output_name(z.outputs[0]))))
					const old_roon_group = old_zone?.outputs?.map(output => {get_pid(get_output_name(output))})
					const new_roon_group = z.outputs.map(output => get_pid(get_output_name(output))).filter(o => o)
					const heos_group = group?.players.map(player => player.pid);
				    if (new_roon_group.length > 1 && (sum_array(old_roon_group) !== sum_array(new_roon_group))  && (sum_array(new_roon_group) !== sum_array(heos_group))){
						await group_enqueue(new_roon_group)	
					} else if (group_pending[pending_index]){	
						group_pending[pending_index].status ="grouped"
					}
					z.group = group 
				}
				rheos_zones.set(z.zone_id,z);
	        	if ((!fixed?.gid || fixed?.gid && z.outputs.length > 1)  && (z.is_pause_allowed) && (rheos.playing_display !== (z.outputs.length == 1 ?"  🎵":"  🎶", z.display_name, " ▶ ",z?.now_playing?.one_line?.line1))){
						rheos.playing_display = (z.outputs.length == 1 ?"  🎵":"  🎶", z.display_name, " ▶ ",z?.now_playing?.one_line?.line1)
				    	console.error(new Date().toLocaleString(),z.outputs.length == 1 ?"  🎵":"  🎶", z.display_name, " ▶ ",z?.now_playing?.one_line?.line1)		
				}			    
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
	}).catch(err => console.error(new Date().toLocaleString(),"⚠ ERROR UPDATING ZONES",err))
}
async function update_player_volume(op,player){
	if (!op?.volume){return}
	let {is_muted,value} = op.volume
	if (!player?.volume){return}
	let {mute = "off",level = 0} = player?.volume 
	if ( level !== value) {
		player.volume.level = value
		await heos_command("player", "set_volume", { pid: player?.pid, level: value }).catch(err => console.error(new Date().toLocaleString(),err))
	}
	if ((mute == 'on' !== is_muted  )) {
		player.volume.mute = is_muted? "on" : "off"
	    await heos_command("player", "set_mute", { pid: player?.pid, state: is_muted ? "on": "off"}).catch(err => console.error(new Date().toLocaleString(),err))
	}
	return
}
async function update_avr_volume(player,mode,value){  
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
				//	services.svc_transport.change_volume(o,mode,value)
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
	log && console.log("-> RHEOS:  REQUEST",commandGroup, command, attributes)
	if (!rheos.connection) {
		console.error(new Date().toLocaleString(),"⚠ NO CONNECTION")
		return
	}
	typeof attributes === "object" || ((timer = attributes), (attributes = {}))
	return new Promise(function (resolve, reject) {
		setTimeout(() => {reject(`Heos command timed out: ${command} ${timer}`) }, timer)
		commandGroup !== "event" && rheos.connection[0].write(commandGroup, command, attributes)
		rheos.connection[0].once({ commandGroup: commandGroup, command: command, attributes }, (res) => {
			log && console.log("<- RHEOS: COMPLETE",JSON.stringify(res))
			res.parsed = res.heos.message.parsed
			res.result = res.heos.result
			if (res.heos.message.unparsed.includes("under process")) {
				rheos.connection[0].once({ commandGroup: commandGroup, command: command, attributes }, (res) => {
				resolve(res)
			})} 
			else if (res.heos.result === "success") {
				resolve(res)}
			else {
				reject(res)	
			}		
		})
	}).catch((err)=> log && console.warn("HEOS COMMAND ERROR",err))
}
async function set_player_resolution(player){
	let device = {} 
	device.udn = player.udn
	device.friendly_name = player.name
	
	switch (player.resolution) {
		case  ( "HR") :{
			device.enabled = '1'
			device.mode = ("flc:0,r:-48000,s:16").toString().concat(rheos.mysettings.flow ? ",flow" : "")
			device.sample_rate = '192000'	
		} 
		break
		case  ( "THRU" ) : {
			device.enabled = '1'
			device.mode = "thru"
			device.sample_rate = '192000'
		}
		break
		default :
			device.enabled = '1'
			device.mode = ("flc:0,r:-48000,s:16").toString().concat(rheos.mysettings.flow ? ",flow" : "")
			device.sample_rate = '48000'
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
			<flow>${rheos.mysettings.flow}</flow>
			<send_metadata>${rheos.mysettings.send_metadata}</send_metadata>
			<send_coverart>${rheos.mysettings.send_coverart}</send_coverart>
			<log_limit>${rheos.mysettings.log_limit}</log_limit>
		</common>
		<device>
			<enabled>1</enabled>
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
	}
	roon.save_config("players",[...rheos_players.values()].map((o) => {let {Z2,PWR,volume,output,zone,state,status,group, ...p} = o;return(p)}));
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
			await fs.chmod(fixed ? './UPnP/Bin/squeezelite/squeezelite-x86-64':'./UPnP/Bin/RHEOS-x86-64', 0o555)
			return(fixed ? './UPnP/Bin/squeezelite/squeezelite-x86-64':'./UPnP/Bin/RHEOS-x86-64')
		} else if (os.arch() === 'ia32'){
			await fs.chmod(fixed ?'./UPnP/Bin/squeezelite/squeezelite-i386':'./UPnP/Bin/RHEOS-x86', 0o555)
			return(fixed ? './UPnP/Bin/squeezelite/squeezelite-i386' :'./UPnP/Bin/RHEOS-x86')
		}
		} catch {
			console.error(new Date().toLocaleString(),"⚠ UNABLE TO LOAD LINUX BINARIES - ABORTING",os)
			process.exit(1)
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
		group_buffer.push({ group, resolve, reject })
		group_dequeue().catch((err)=>{log && console.error(new Date().toLocaleString(),"Deque error",err)})
		})
	}
return
}	
async function group_dequeue(timer = 5000) {
	if (rheos.working || !group_buffer.length) { 
		return }
	const item = group_buffer[0]
	if (!item) {
		return
	}
	rheos.working = true
	await heos_command("group", "set_group", { pid: item?.group?.toString() },timer).catch((err) => {console.log(sum_array(item.group));item.resolve(err); rheos.working = false; group_dequeue() })
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
	const res = await heos_command("group", "get_groups",3000).catch(err => console.error(new Date().toLocaleString(),err))
	if (res?.payload?.length) {
		for (const group of res.payload) {
			group.sum_group = sum_array(group.players.map(player => player.pid))
			for await (let player of group.players){
				let p = rheos_players.get(player.pid)
				p && (p.gid = group.gid)
			}
			rheos_groups.set(group.gid, group)	;
		}
		const remove = old_groups.filter(group => !rheos_groups.has(group))
		for (let group of remove){
			services.svc_transport.ungroup_outputs(services.svc_transport.zone_by_output_id(rheos_players.get(group)?.output)?.outputs)
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
		display_version: "0.9.3-06",
		publisher: "RHEOS",
		email: "rheos.control@gmail.com",
		website: "https:/github.com/LINVALE/RHEOS",
		log_level:  "none",
		core_paired: async function (core) {
			log && console.log(new Date().toLocaleString()+ " ROON PAIRED ",roon.extension_reginfo.extension_id)
			log && console.log("ROON SERVER IP ADDRESS",roon.paired_core?.moo?.transport?.host)
			roon.paired = true
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
					case "NetworkError" : {console.error(new Date().toLocaleString(),'⚠',"SUBSCRIBED OUTPUT ERROR",cmd)
					}
					break
					default: console.error(new Date().toLocaleString(),'⚠',"SUBSCRIBED OUTPUT UNKNOWN ERROR",cmd)	
				}
			})
			services.svc_transport.subscribe_zones(async function (cmd, data) {
				switch(cmd){
					case "Subscribed" : 
						for await (const z of data.zones) {
							 get_player_by_name(get_output_name(z.outputs[0])) &&	rheos_zones.set(z.zone_id, z)  
						}
						Array.isArray(data.zones_subscribed) && await update_zones(data.zones_subscribed,true)
					case "Changed" : {	
						if (Array.isArray(data.zones_added)){
							for await (const z of data.zones_added) {
								get_player_by_name(get_output_name(z.outputs[0])) &&	rheos_zones.set(z.zone_id, z)  
							}	
						}
							Array.isArray(data.zones_added) && update_zones(data.zones_added);
							Array.isArray(data.zones_changed) && update_zones(data.zones_changed);
							Array.isArray(data.zones_removed) && update_zones(data.zones_removed);	
					}	
					break
					case "NetworkError" : {
						console.error(new Date().toLocaleString(),'⚠',"SUBSCRIBED ZONE ERROR ",cmd,data)
					}
					break
					default: console.error(new Date().toLocaleString(),'⚠',"SUBSCRIBED ZONE UNKNOWN ERROR",cmd,data)
				}
			})
		},
		core_unpaired: async function (core) {
			console.error(new Date().toLocaleString(),"⚠ CORE UNPAIRED")
            roon.paired = false
			core = undefined
		}
		})
		if (roon){
			resolve (roon)
		} else{
			console.error(new Date().toLocaleString(),"⚠ NO ROON API FOUND PLEASE CHECK YOUR ROON SERVER IS SWITCHED ON AND ACCESSIBLE AND TRY AGAIN");
			reject
		}
	})
}
async function update_status(message = "",warning = false){
	let RheosStatus = rheos_players.size + " HEOS Players on " + rheos.system_info[2] +" "+ rheos.system_info [3]+" "+ rheos.system_info [4] + ' at ' + rheos.system_info[0] + '  for ' + get_elapsed_time(start_time) + '\n'
	for (let zone of [...rheos_zones.values()].filter(zone => (get_player_by_name(get_output_name(zone.outputs[0])) && ! get_output_name(zone.outputs[0]).includes("🔗") && zone.state ==="playing") )) {	
		RheosStatus = RheosStatus + (zone.outputs.length == 1 ?"🎵 ":"🎶  ") + (zone.fixed?.zone?.output || zone.display_name) + "\t ▶ \t" + zone.now_playing?.one_line?.line1 + "\n"
	}
	message && (RheosStatus = RheosStatus + "\n" + message)
	services.svc_status.set_status(RheosStatus,warning)
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
function makelayout(settings) {
	const players = [...rheos_players.values()],
	ips = players.map(player => new Object({ "title": player.model + ' (' + player.name + ') ' + ' : ' + player.ip, "value": player.ip }))
	ips.push({ title: "No Default Connection", value: undefined })
	let l = {values: settings,layout: [],has_error: false}
	l.layout.push(ips.length > 1 ? { type: "dropdown", title: "Default Heos Connection", values: ips, setting: "default_player_ip" }: { type: "string", title: "Default Heos Player IP Address", maxlength: 15, setting: "default_player_ip" })
	l.layout.push({ type: "string", title: "Roon Extension Host IP Address", maxlength: 15, setting: "host_ip" })
	l.layout.push({ title: "Enable AVR Zone Control ", type: "dropdown", setting: 'avr_control', values : [{title: "ON", value : 1},{title : "OFF", value :0}]})
	l.layout.push({ title: "Enable Fixed HEOS Groups ", type: "dropdown", setting: 'fixed_control', values : [{title: "ON", value : 1},{title : "OFF", value :0}]})
	l.layout.push({ title: "Enable Logging ", type: "dropdown", setting: 'log', values : [{title: "ON", value : true},{title : "OFF", value :false}]})
	if (players.length) {
		let _players_status = { type: "group", title: "PLAYERS", subtitle: "Set player resolution", collapsable: true, items: [] }
		for (let player of players){
			if (player) {
				_players_status.items.push({title: ('◉ ') + player.name.toUpperCase(),type: "dropdown",
					values: [{ title: "Hi-Resolution", value: "HR" }, { title: "CD Quality", value: "CD" },{ title: "Pass Through", value: "THRU" }],
					setting: player.pid.toString()
				})
			}
		}
		l.layout.push(_players_status)
	}
	if (rheos.mysettings.avr_control){
		let _avrs = { type: "group", title: "AUTO PLAY", subtitle: "Set for devices with power ON/OFF", collapsable: true, items: [] };
		for (let player of rheos_players) {
			if (Array.isArray(player[1].PWR)) {
				let values = [
					{title : "OFF", value :"-1"},
					{title : "No-Delay", value :"0"}]
					for (let i = 0; i < 21; i++) {
						values.push ({title : i, value : i})
					}
				_avrs.items.push({title: player[1].name, subtitle: "Set delay (secs)",type: "dropdown",values: values, setting: "A"+player[1].pid.toString()})
			}
		}
		l.layout.push(_avrs)
	}
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
		{ title: "● Buffer Size", type: "dropdown", setting: 'streambuf_size', values: [{ title: "Small", value: 524288 }, { title: "Medium", value: 524288 * 2 }, { title: 'Large', value: 524288 * 3 },{ title: 'Giant', value: 524288 * 5}] },
		{ title: "● Output Size", type: "dropdown", setting: 'output_size', values: [{ title: 'Small', value: 4194304 }, { title: 'Medium', value: 4194304 * 2 }, { title: 'Large', value: 4194304 * 3 }] },
		{ title: "● Stream Length", type: "dropdown", setting: 'stream_length', values: [{ title: "no length", value: -1 }, { title: 'chunked', value: -3 }] },
		{ title: "● Seek After Pause", type: "dropdown", setting: 'seek_after_pause', values: [{ title: "On", value: 1 }, { title: 'Off', value: 0 }] },
		{ title: "● Volume On Play", type: "dropdown", setting: 'volume_on_play', values: [{ title: "On Start Up", value: 0 }, { title: 'On Play', value: 1 }, { title: "Never", value: -1 }] },
		{ title: "● Volume Feedback", type: "dropdown", setting: 'volume_feedback', values: [{ title: "On", value: 1 }, { title: 'Off', value: 0 }] },
		{ title: "● Accept Next URI", type: "dropdown", setting: 'accept_nexturi', values: [{ title: "Off", value: 0 }, { title: 'Force', value: 1 }, { title: "Manual", value: -1 }] },
		{ title: "● Flac Header", type: "dropdown", setting: 'flac_header', values: [{ title: "None", value: 0 }, { title: 'Set sample and checksum to 0', value: 1 }, { title: "Reinsert fixed", value: 2 }, { title: "Reinsert calculated", value: 3 }] },
		{ title: "● Keep Alive", type: "integer", setting: 'keep_alive', min: -1, max: 120 },
		{ title: "● Next Delay", type: "integer", setting: 'next_delay', min: 0, max: 60 },
		{ title: "● Send Metadata", type: "dropdown", setting: 'send_metadata', values: [{ title: "On", value: 1 }, { title: 'Off', value: 0 }] },
		{ title: "● Send Cover Art", type: "dropdown", setting: 'send_coverart', values: [{ title: "On", value: 1 }, { title: 'Off', value: 0 }] },
		{ title: "● Flow Mode", type: "dropdown", setting: 'flow', values: [{ title: "On", value: 1 }, { title: 'Off', value: 0 }] },
		{ title: "● Log File Size Limit (MB) -1 for unlimited", type: "integer", setting: 'log_limit', min: -1, max: 10 },
		{ title: "● ROON UPnP Server Address", type: "string",  maxlength: 15, setting: "upnp_ip" }
		]
	})
	l.layout.push({
		type: "group", title: "REFRESH HEOS PLAYERS" , subtitle :"Use if new or removed player not automatically detected", collapsable: true, items: [
			{ title: "● REFRESH HEOS PLAYERS", type: "dropdown", setting: 'refresh_players', values: [{ title: "YES", value: 1},{ title: "NO", value: 0} ] },
		]
	})
	l.layout.push({
		type: "group", title: "RESET ALL SETTINGS" , subtitle :" Changes are irreversible, use with caution", collapsable: true, items: [
			{ title: "● RESET STATUS TO DEFAULTS", type: "dropdown", setting: 'clear_settings', values: [{ title: "YES", value: 1}, { title: "NO", value: 0}] },
		]
	})
	return (l)
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
    const handle = function(signal) {
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