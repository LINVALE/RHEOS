const version = "0.8.4-0"
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
import xml2js, { parseStringPromise } from "xml2js"
import util from "node:util"
import HeosApi from "heos-api"
import RheosConnect from "telnet-client"
var roon, paired = false,svc_status, mysettings, group_volume_control,avrs, svc_transport, svc_volume_control, svc_source_control, svc_settings, rheos_connection, myplayers, squeezelite, avr_control,fixed_control,fixed_group_control = {},myfixed_groups = [],zone_control = {},block_avr_update = false
const fixed_groups = new Map()
const all_groups = new Map()
const system_info = [ip.address(), os.type(), os.hostname(), os.platform(), os.arch()]
const rheos = { processes: {}, mode: false, discovery: 0, working: false, avr : {} , has_avr : false}
const start_time = new Date()
const group_buffer = []
const output_buffer = []
const avr_buffer = {}
const execFileSync = util.promisify(child.execFile);
const exec = (child.exec)
const spawn = (child.spawn)
const rheos_players = new Map()
const rheos_zones = new Map()
const rheos_outputs = new Map()
const rheos_groups = new Map()
const group_pending =[]
const avr_zone_controls = {}
const avr_volume_controls = {}
const rheos_connect = RheosConnect.Telnet
const builder = new xml2js.Builder({ async: true })
const devices = {}
const log = process.argv.includes("-l")||process.argv.includes("-log") 
const sound_modes = ["MSSTEREO","MSDIRECT","MSPURE DIRECT","MSMCH STEREO","MSVIRTUAL"]
init_signal_handlers()
await start_up().catch((err) => console.log("ERROR STARTING UP",err))
async function start_up(){
	return new Promise (async function (resolve,reject)	{
	exec("pkill -f -9 UPnP")
	exec("pkill -f -9 squeezelite")
    squeezelite = "squeezelite"
	await start_roon().catch(err => console.error(new Date().toLocaleString(),"⚠ Error Starting Roon",err => {throw error(err),reject()}))
	console.log(system_info.toString(),"Version :",roon.extension_reginfo.display_version)
	const c = spawn("squeezelite")
		c.on('error', async function(err) {
		log && console.error(new Date().toLocaleString(),'SQUEEZELITE NOT INSTALLED : LOADING BINARIES');
		squeezelite = await choose_binary("squeezelite",true).catch(err => console.error(new Date().toLocaleString(),"⚠ Error Loading Squeezelite Binaries",err => {throw error(err),reject()}))
	})
	await start_heos().catch(err => console.error(new Date().toLocaleString(),"⚠ Error Starting Heos",err => {throw error(err),reject()}))
	await start_listening()
	await discover_devices().catch(err => console.error(new Date().toLocaleString(),"⚠ Error Discovering Devices",err => {throw error(err),reject()}))
	await build_templates().catch(err => console.error(new Date().toLocaleString(),"⚠ Error Building Templates",err => {throw error(err),reject()}))
	await build_devices().catch(err => console.error(new Date().toLocaleString(),"⚠ Error Building Devices",err => {throw error(err),reject()}))
	log && console.log("ROON SERVER IP ADDRESS",roon.paired_core?.moo?.transport?.host)
	await create_zone_controls().catch(err => console.error(new Date().toLocaleString(),"⚠ Error Creating Zone Controls",(err) => {throw error(err),reject()}))
	log && console.log("ADDING LISTENERS")
	await add_listeners().catch(err => console.error(new Date().toLocaleString(),"⚠ Error Adding Listeners",err => {throw error(err),reject()}))
	log && console.log("UPDATING HEOS GROUPS")
	await update_heos_groups().catch(err => console.error(new Date().toLocaleString(),"⚠ Error Updating HEOS groups",err => {throw error(err),reject()}))
	log && console.log("CREATING FIXED GROUPS")
	await create_fixed_group_control().catch(err => console.error(new Date().toLocaleString(),"⚠ Error Creating Fixed Groups",err => {throw error(err),reject()}))
	fixed_control && await load_fixed_groups().catch(err => console.error(new Date().toLocaleString(),"⚠ Error Loading Fixed Groups",(err) => {throw error(err),reject()}))
	log && console.log("SETTINGS",Object.entries(mysettings).filter(o => isNaN(o[0])))
	avr_control && monitor_avr_status()
	resolve()
	}) .catch(err => console.error(new Date().toLocaleString(),"⚠ Error STARTING UP",(err) => {throw error(err),reject()}))
}

async function add_listeners() {
	log && console.log("SETTING LISTENERS")
	process.setMaxListeners(32)
	rheos_connection[0].socket.setMaxListeners(32)
	rheos_connection[1].socket.setMaxListeners(32)
	rheos_connection[1].write("system", "register_for_change_events", { enable: "on" })
		.on({ commandGroup: "system", command: "heart_beat" }, async (res) => {
			res?.heos?.result == "success" || console.error(new Date().toLocaleString(),"⚠ HEARTBEAT failed", res)
		})
		.onClose(async (hadError) => {
			console.error(new Date().toLocaleString(),"⚠ Listeners closed", hadError)
			if (hadError) await start_up().catch(err => { console.error(new Date().toLocaleString(),err) })
		})
		.onError((err) => console.error(new Date().toLocaleString(),"⚠ HEOS REPORTS ERROR", err))
		.on({ commandGroup: "event", command: "groups_changed" }, async (res,pending,pending_zone) => {
			await update_heos_groups().catch(err => console.error(new Date().toLocaleString(),err))
			if (group_pending.length){
				pending_zone = svc_transport.zone_by_output_id(group_pending[0][1])
				pending = get_zone_group_value(pending_zone)
			}
			for (const group of [...rheos_groups.values()]) {
				if (pending == group.sum_group){
					svc_transport.control(pending_zone,'play')
				}
				const players =	group.players.sort((a, b) => {let fa = a.role == "leader" ? 0 : 1; let fb = b.role == "leader" ? 0 : 1; return fa - fb} )	
				const zone = svc_transport.zone_by_output_id(rheos_players.get(group.gid)?.output);
				const new_outputs= players?.map(player => rheos_players.get(player.pid)?.output).filter(Boolean) || []
				const old_outputs = zone?.outputs.map(output => output?.output_id) || []
				if (get_zone_group_value(zone) !== get_heos_group_value(group)) {
					if (new_outputs?.length >1 && new_outputs?.length > old_outputs?.length) {
						svc_transport.group_outputs(new_outputs)
					}
					else {
						let removed_outputs = old_outputs?.filter(op => !new_outputs?.includes(op))
						svc_transport.ungroup_outputs(removed_outputs)
					}
				} 
			}
		})
		.on({ commandGroup: "event", command: "players_changed" }, async (res) => {
			log && console.log("⚠ PLAYERS HAVE CHANGED")
		})
		.on({ commandGroup: "event", command: "player_playback_error" }, async (res) => {
			if ( res.heos.message.parsed.error.includes("Unable to play media")){
				svc_transport.control(rheos_players.get(res.heos.message.parsed.pid)?.zone, 'play')
			}
			else {
				console.error(new Date().toLocaleString(),"⚠ PLAYBACK ERROR - ATTEMPTING TO PLAY AGAIN", res.heos.message.parsed.error)
				svc_transport.control(rheos_players.get(res.heos.message.parsed.pid)?.zone, 'play')
			}
		})
		.on({ commandGroup: "event", command: "player_volume_changed" }, async (res) => {
			const { heos: { message: { parsed: { mute, level, pid } } } } = res, player = rheos_players.get(pid), output = rheos_outputs.get(player?.output)
			if (output && paired){
				if (mute != player.volume.mute) {
					player.volume.mute = mute
					svc_transport.mute(player.output, (mute == 'on' ? 'mute' : 'unmute'))	
				}
				if (level !== player?.volume?.level) {
					player.volume.level = level
					svc_transport.change_volume(output, 'absolute', level)
				}
			}	
		})
		.on({ commandGroup: "event", command: "group_volume_changed" }, async (res) => {
			const { heos: { message: { parsed: { mute,level,gid } } } } = res, group = rheos_groups.get(gid)
			if (!group){return}
			let fixed_zone = svc_transport.zone_by_output_id(rheos_players.get(group.gid)?.output)
			if (!fixed_zone) {return}
			group.volume = {mute : mute, level : level}
			if ([...fixed_groups.keys()].includes(get_zone_group_value(fixed_zone))){
            	let output = fixed_zone?.outputs[fixed_zone.outputs.length -1]
				if (level !== output.volume.level){
					svc_transport.change_volume(fixed_zone?.outputs[fixed_zone.outputs.length -1],'absolute',level)
				}
				if ((mute == 'on'!== output.volume.mute) ) {
					svc_transport.mute(fixed_zone?.outputs[fixed_zone.outputs.length -1], (mute == 'on' ? 'mute' : 'unmute'))	
				}
			}
		})	
}
async function discover_devices() {
	log && console.log("DISCOVERING DEVICES")
	let message = setInterval(
		function () {
			rheos.discovery++;
			if (rheos.discovery > 50) {
				if (rheos.discovery <300){		
					update_status(
					`RHEOS ONLY DISCOVERS MARANTZ AND DENON HEOS ENABLED DEVICES
					 ⚠ STOPPING RHEOS IN ${300 - rheos.discovery} SECONDS`, rheos.discovery > 200)
				} else {
					process.exit(0)	
				}		
			} else {
				rheos.mode = true
				update_status("BUILDING PLAYERS",false)
			}	
		}, 1000
	)
	return new Promise(async function (resolve) {
		const players = await get_players().catch(err => console.log(err))
			try {
				    log && console.log('READING PROFILES')
					update_status("READING PROFILES",false)
					const data = await fs.readFile('./UPnP/Profiles/config.xml', 'utf8')
					const slim_devices = await parseStringPromise(data)
					const devices = slim_devices.squeeze2upnp.device.map(d => d.friendly_name[0])
            	if (players.length && players.every((player) => {return devices.includes(player.name)})){	
					clearInterval(message)
					log && console.log('PLAYERS UNCHANGED')
					update_status("PLAYERS UNCHANGED",false)
					rheos.discovery=0
					rheos.mode = false
					resolve()
				} else {
					log && console.error(new Date().toLocaleString(),"DIFFERENT PLAYERS")
					throw error
				}
			} catch {
				log && console.error(new Date().toLocaleString(),"UPDATING CONFIG")
				update_status("PLAYERS HAVE CHANGED - UPDATING CONFIGURATION",false)
				await create_root_xml().catch(err => {
					resolve(discover_devices(err))
				})
				clearInterval(message)
				rheos.discovery ++
				resolve ()
			}
	})
}
async function create_root_xml() {
	log && console.error(new Date().toLocaleString(),"CREATING ROOT XML")
	const app = await (choose_binary("SYSTEM")).catch(() =>{
		log && console.error(new Date().toLocaleString(),"⚠ BINARY NOT FOUND")
		setTimeout(()=>{process.exit(0)},500)
	})
	return new Promise(async function (resolve,reject) {	
		try {
			log && console.error(new Date().toLocaleString(),"CREATING CONFIG FROM IP", system_info[0])
			rheos.mode = true
			let app = await choose_binary(system_info)	
			try {
			  	await execFileSync(app, ['-i', './UPnP/Profiles/config.xml', '-b', system_info[0]])
			} catch (err) {
				console.log("ERROR CREATING CONFIG XML",err);
			}
			resolve()
		} 
		catch {
			reject(err)
		}
	})
}
async function start_heos(counter = 0) {
	counter > 0 && console.log( "RECONNECTING TO HEOS", counter)
	counter >20 && process.exit(0)
	return new Promise (async function (resolve,reject){
		log && console.log("STARTING HEOS")
		rheos_connection || (rheos_connection = await  Promise.all([HeosApi.discoverAndConnect({timeout:10000,port:1255, address:system_info[0]}),HeosApi.discoverAndConnect({timeout:10000,port:1256, address:system_info[0]})]))
		rheos_connection[0].socket.setMaxListeners(32)
		rheos_connection[1].socket.setMaxListeners(32)
		const players = await get_players().catch(()=>{console.error(new Date().toLocaleString(),"⚠ Unable to discover Heos Players");throw new Error('Unable to Get Heos Players');})
		if (Array.isArray(players)){
			for await (let player of players) {
			   	if (typeof(player) == "object" && player.pid) {
					if (!player.ip) {
						player = await heos_command('player','get_player',{pid : player?.pid}).catch(()=>{console.error(new Date().toLocaleString(),"⚠ Unable to discover Heos Players");throw new Error('Unable to Get Heos Players');})
					    if (!player.ip){start_heos(counter ++)}
					}
					rheos_players.set(player.pid, player)
					player.resolution = myplayers.find(p => p.pid == player.pid)?.resolution || "CD"
					player.volume = {}
					player.pid && rheos_players.set(player.pid, player)
					fs.access('./UPnP/Profiles/' + player.name + '.log').then(() => fs.truncate('./UPnP/Profiles/' + player.name + '.log', 0)).catch(()=> {})
					myplayers.findIndex(p => p.pid == player.pid) > -1 || myplayers.push(player)
				}
			}	
			players.sort((a, b) => {
					let fa = a.network == "wired" ? 0 : 1
					let fb = b.network == "wired" ? 0 : 1
					return fa - fb
			})
			console.table(players, ["name", "pid", "model", "ip", "resolution","network"])
			roon.save_config("settings",mysettings);
			roon.save_config("players",[...rheos_players.values()].map((o) => {let {Z2,PWR,volume,output,zone,state,status,group, ...p} = o;return(p)}));
			resolve	(players)
		} else {
			reject (start_heos(counter ++))
		}		
	})
}
async function get_players() {
	return new Promise(function (resolve, reject) {
		if (!rheos_connection) {reject("AWAITING CONNECTION")}
		rheos_connection[1]
		.write("player", "get_players", {})
		.once({ commandGroup: 'player', command: 'get_players' }, (players) => {
			switch(true){
				case (players?.payload?.length > 0) : {
					resolve(players?.payload)
				}	
				break
				case (players.heos.result === "failed"):{
					console.error(new Date().toLocaleString(),"UNABLE TO GET PLAYERS",players)
					reject()
				}			
				break
				case (players.heos.message.unparsed == "command under process"):{
					rheos_connection[1]
					.once({ commandGroup: 'player', command: 'get_players' }, (players) => {
						resolve( players?.payload)}).catch(err => {console.log(err)
					})
				} 
				break
				case (players?.payload?.length > 16) : {
					console.log("⚠ LIMIT OF 16  HEOS PLAYERS EXCEEDED ",players.payload.length)
					reject()
				}
				break
				default : {
					console.log("⚠ ERROR GETTING PLAYERS",players)
					reject()
					process.exit(0)	
				} 
			}
		})
	})
}
async function compare_players(){
	console.log("COMPARING PLAYERS")
	const old_pids = [...rheos_players.keys()]
	const new_players = await get_players().catch(() => {console.error(new Date().toLocaleString(),"⚠ UNABLE TO GET PLAYERS TO COMPARE")})
	if (!new_players) {return}
	const new_pids = new_players.map(p => p?.pid)
	const newp =  new_pids.filter(new_pid => !old_pids.includes(new_pid))
	const delp =  old_pids.filter(old_pid => !new_pids.includes(old_pid))
	if (delp.length) {
		delp.forEach( (d)=>{
			rheos_players.delete(d)
			if (rheos.processes[d]?.pid){
				process.kill(Number(rheos.processes[d].pid))
				delete rheos.processes[d]	
			}
		})
	}
	if (newp.length){
		newp.forEach(async (p)=> {
			let player = new_players.find(player => player?.pid == p)
            const res = await heos_command('player','get_volume',{pid : player?.pid})
			player.volume = {}
			player.volume.level = res?.parsed?.level
			rheos_players.set (p, player)
			create_player(p)	
		})
	} 
	return
}
async function create_player(pid) {
    if (rheos.processes[pid]){
		process.kill(Number(rheos.processes[pid].pid))
		delete(rheos.processes[pid])
	}
	const player = rheos_players.get(Number(pid))
	if (player){
		console.log("CREATING",player.name)
		const name = player.name
		const app = await (choose_binary(name)).catch(err => console.error(new Date().toLocaleString(),"Failed to find binary",err))
		rheos.processes[player.pid] = spawn(app, ['-b', system_info[0], '-Z', '-M', name,
		'-x', './UPnP/Profiles/' + name + '.xml', 
		'-p','./UPnP/Profiles/' + name + '.pid',
		'-f', './UPnP/Profiles/' + name + '.log',
		'-s', mysettings.upnp_ip]),
		{ stdio: 'ignore' }
	}
	return 
}
async function load_fixed_groups(){
	fixed_groups.size &&
	[...fixed_groups.entries()].forEach( async fg => {
			create_fixed_group(fg).catch(()=> {})
	})
	return
}
async function create_fixed_group(group){
	await group_enqueue(group[1].gid)
	const fixed = Math.abs(group[1].sum_group).toString(16);
	if (rheos.processes[fixed]?.pid){
		try { 
			process.kill( rheos.processes[fixed]?.pid,'SIGKILL') 
			fixed_groups.delete(group[1].sum_group)
			all_groups.delete(group[1].sum_group)
		} catch { console.error(new Date().toLocaleString(),"⚠ UNABLE TO DELETE PROCESS FOR",group)}	
	}
    const name = group[1].name.split("+")
	const display_name = "🔗 " +name[0].trim()+" + " + (name.length -1)
	group[1].display_name = display_name
	fixed_groups.set(group[1].sum_group,group[1])
	mysettings[group[1].sum_group.toString()]=[group[1].resolution]
	myfixed_groups.findIndex(g => g.sum_group === group[1].sum_group) > -1 || myfixed_groups.push(group[1])
	const mac = "bb:bb:bb:"+ fixed.replace(/..\B/g, '$&:').slice(1,7)
	rheos.processes[fixed] = spawn(squeezelite,["-a","24","-r",group[1].resolution +" : 500","-M",display_name,"-m", mac,"-o","-","-p","99","-W","-v"])
	await get_all_groups()
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
			block_avr_update = true
			setTimeout( () => {
				req.send_complete("Success")
				block_avr_update = false
			},3000)
		},  
		standby:  async function (req) {
			log && console.log("STANDING BY FIXED GROUP")
			req.send_complete("Success")				 
		}
	}
	Object.keys(fixed_group_control).length === 0 && (fixed_group_control = svc_source_control.new_device(controller))
	return
}
async function remove_fixed_group(g) {
	try { 	
		process.kill(rheos.processes[Math.abs(g).toString(16)].pid)
	}
	catch { }	
		await get_all_groups()
   	return 
}
async function start_roon() {
	console.error(new Date().toLocaleString(),"STARTING ROON")
	const def = JSON.parse(await fs.readFile('./default_settings.json','utf-8'))
	roon = await connect_roon().catch((err)=> {console.error(new Date().toLocaleString(),"Failed to connect with ROON server",err)})
	svc_status = new RoonApiStatus(roon)
	svc_transport = new RoonApiTransport(roon)
	svc_source_control = new RoonApiSourceControl(roon)
	svc_volume_control = new RoonApiVolumeControl(roon)
	mysettings = roon.load_config("settings")|| def.settings || {}
	mysettings.log_limit || (mysettings.log_limit = 1)
	myplayers = roon.load_config("players") || []
	mysettings.clear_settings = false	
	fixed_control = mysettings.fixed_control
	avr_control = mysettings.avr_control || false
	roon.start_discovery()
	if (fixed_control){
		let  g = roon.load_config("fixed_groups") || []
		myfixed_groups = g
		Array.isArray (myfixed_groups)  &&   myfixed_groups?.forEach(g => {
			g.state = 'paused';fixed_groups.set(g.sum_group,g)
		})			
	}
	svc_settings = new RoonApiSettings(roon, {
		get_settings: async function (cb) {
			Array.isArray(myplayers) && myplayers.forEach(p => {
				mysettings[p.pid] = p.resolution
				if (p.type) {mysettings["M"+p.pid] = p.sound_mode}
			})
			mysettings.upnp_ip = mysettings.upnp_ip || roon.paired_core?.moo?.transport?.host
			Array.isArray(myfixed_groups) && myfixed_groups.forEach(g => {mysettings[g.sum_group] = (g.resolution)})
			cb(makelayout(mysettings))
		},
		save_settings: async function (req, isdryrun, settings) {
			let l = makelayout(settings.values)
			if (!isdryrun && !l.has_error) {
				if (mysettings.clear_settings) {
					mysettings.clear_settings = false; mysettings = def.settings
				} 
				if (mysettings.upnp_ip !== settings.upnp_ip){
					for await (let player of [...rheos_players.values()]){		
					     create_player(player.pid)
					}
				}
				mysettings = settings.values
				for await (let player of [...rheos_players.values()]){		
					if(player.resolution !== l.values[player.pid] ){
						player.resolution = l.values[player.pid] || "CD"
						rheos_players.set(player.pid,player)
						delete(settings[player.pid])
						log && console.log("UPDATING RESOLUTION",player.name,player.resolution)
						await build_devices(player).catch(()=>{console.error(new Date().toLocaleString(),"Failed to build devices")})
					}
					if (player.type){
						player.sound_mode =  settings.values["M"+player.pid.toString()]
						delete (settings.values["M"+player.pid.toString()])
					}
					delete(mysettings[player.pid])
				}
				if (Array.isArray(myfixed_groups)){
					for await (let group of myfixed_groups){
						if(group.resolution !== l.values[group.sum_group] ){
							group.resolution = l.values[group.sum_group] 
							fixed_groups.get(group.sum_group).resolution = group.resolution
						}
						delete(myfixed_groups[group.sum_group])
					}	
					for await (let fg of all_groups){		
						let index = myfixed_groups.findIndex(f => f.sum_group == fg[1].sum_group) 
						if (index === -1){
							fg[1].resolution = settings.values[fg[1].sum_group]	
							await create_fixed_group(fg)
						} else {
							let group = myfixed_groups[index]
							if (myfixed_groups[index].resolution == -1){
								myfixed_groups.splice(index,1)
								fixed_groups.delete(group.sum_group)
								delete mysettings[group.sum_group]
								remove_fixed_group(group.sum_group)
							}
						}	
					delete mysettings[fg[1].sum_group.toString()]
					}
				}
				fixed_control = mysettings.fixed_control = settings.values.fixed_control
				!fixed_control &&  (myfixed_groups = [])
				avr_control = mysettings.avr_control = settings.values.avr_control
				if (!avr_control){ 
					let avrs = [...rheos_players.values()].filter(player => player.type == "AVR")
					for (let avr of avrs){
						avr_volume_controls[avr.pid]?.update_state({	state: {
							volume_type:  "number"
						}})
					}
					for (let o of Object.entries(avr_zone_controls)){
						let zone = svc_transport.zone_by_output_id(o[1]?.output?.output_id)	
						if (zone?.outputs){
							svc_transport.ungroup_outputs(zone.outputs)
						}
						if (avr_zone_controls[o[0]]){
							await kill_avr_output(Number(o[0]))
						} 	
					}		
				} else {
					await create_zone_controls().catch(err => console.error(new Date().toLocaleString(),"⚠ Error Creating Zone Controls",(err) => {throw error(err),reject()}))
				}
				roon.save_config("fixed_groups",myfixed_groups)
				roon.save_config("settings", mysettings)
				roon.save_config("players",[...rheos_players.values()].map((o) => {let {gid,Z2,PWR,volume,output,zone,state,status,group, ...p} = o;return(p)}));	
			}
			req.send_complete(l.has_error ? "NotValid" : "Success", { settings: l })
		
		
		
		}
	})
	console.log("INITIATING SERVICES")
	roon.init_services({
		required_services: [RoonApiTransport], provided_services: [	svc_status,	svc_settings, svc_source_control,svc_volume_control], 
	})
	return (roon)
}
async function control_avr(ip,command,req) {
    avr_buffer[ip] = []
	Array.isArray(command) && (command = command.filter(o => o))
	if (!command) {return }
	return new Promise(async (resolve, reject) => {	
       if(avr_buffer[ip].findIndex(o => {o.item[0] == ip && (o.item[1].slice(0,1) ==  command.slice(0,1)) && !isNaN(command.slice(2,4)) })>-1){
		log && console.log ("ALREADY BUFFERING",ip,command)
		}
		block_avr_update = true
	 	avr_buffer[ip].push({ item: Array(ip,command,req), resolve, reject })
		await avr_dequeue(ip).catch((err)=>{console.error(new Date().toLocaleString(),"Deque error",err)})	
		block_avr_update = false
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
		if (req.req) {
			log && console.log("AVR BUFFER SENDING COMPLETE SUCCESS")
			req.req.send_complete("Success")
		}
		req && req.resolve(res)	
	}
	catch {
		req && req.resolve(res)
	}
	await avr_dequeue()	
}
async function create_zone_controls(err,count=0) {	
	log && console.log("CREATING ZONE CONTROLS")
	if (!rheos_players.size && count <10){setTimeout(async ()=>{
		log && console.error(new Date().toLocaleString(),"NO PLAYERS DETECTED- TRYING AGAIN",count )
		await create_zone_controls(false,count++)},500);
		return 
	} else if (rheos_players.size){
		let failed_connections= []
		for await (let player of rheos_players){
			if ((!player[1].model.includes("HEOS"))&&(!player[1].model.includes("Home"))){
				log && console.log(player.type === "AVR" ? "CONNECTING AVR" : "TESTING IF AVR",player[1].name)
				err = connect_avr(player[0]).catch(err => console.log(err,"⚠  ERROR CONNECTING AVR",player.name))
				if (err) {failed_connections.push[player[1]]}
			}
		} 
		let i = 0
		while (failed_connections.length && i< 11){
			for await (let player of failed_connections){
				err = await connect_avr(player[0]).catch(()=> {console.log("FAILED TO CONNECT AVR")})
				err && failed_connections.shift()
			}	
			i++
		}
		if (i == 11){console.error(new Date().toLocaleString(),"⚠ FAILED TO SET AVR CONTROLS FOR ",failed_connections.map(p => p[1].name))}
		roon.save_config("players",[...rheos_players.values()].map((o) => {let {Z2,PWR,volume,output,zone,state,status,group, ...p} = o;return(p)}));
		avr_control && log &&console.log("STARTING TO MONITOR AVRS")
	    
	} else {
		console.error(new Date().toLocaleString(),"⚠ UNABLE TO DISCOVER ANY HEOS PLAYERS - ABORTING")
		process.exit(0)
	}
	return
}
async function connect_avr(pid){	
	let avr = rheos_players.get(pid) 
	avr.PWR = await control_avr(avr.ip,"PW?").catch((err)=>{console.error(new Date().toLocaleString(),"FAILED TO CONNECT",err)})
	if (Array.isArray (avr.PWR)){
		log && console.log(avr.name.toUpperCase(), "HAS POWER SWITCH",)
	}
	avr.Z2 = await control_avr(avr.ip,"Z2?").catch((err)=>{console.error(new Date().toLocaleString(),"FAILED TO CONNECT",err)})
	if (avr_control && Array.isArray (avr.Z2) && avr.Z2.length >1){
		log && console.log(avr.name.toUpperCase(), "HAS ZONE 2")
		await create_avr_controls(avr).catch((err)=>{console.log(err)})
		avr.type = "AVR"
		avr.status = []	
		let sm = await control_avr(avr.ip,"MS?").catch((err)=>{console.error(new Date().toLocaleString(),"FAILED TO CONNECT",err)})
		log && console.log(avr.name.toUpperCase(), "SOUND MODE IS",sm[0].slice(2))
		avr.sound_mode = sm[0]
		return("AVR")						    
	} else { 
		avr.type = undefined;
		return(undefined)
	}
}
function monitor_avr_status() {
	setTimeout(async () => {
		let avrs = [...rheos_players.values()].filter(p => p.type === "AVR")
		for await (const avr of avrs){
			!block_avr_update && avr_control && update_avr_status(avr).catch(() => {console.log("ERROR MONITORING AVR STATUS")})
		}
	  	monitor_avr_status();
	}, 1000)
}
async function update_avr_status(avr){
	return new Promise(async function (resolve) {
		const avrs = Object.entries(avr_zone_controls).filter(o => o[1].state.ip == avr.ip)
		const status = new Set (await (control_avr(avr.ip,"\rZM?\rSI?\rMV?\rMU?\rZ2?\rZ2MU?\rZ?\rMS?\r")))
		paired || log && process.stdout.write(new Date().toLocaleString()+ (" UNPAIRED\r"))
		if(svc_transport && paired){
			if (avr_control && status.size == 18){
				let s = [...status].join(" ")
				let index = 0
				
				for await (let control of avrs){
					const op = rheos_outputs.get(control[1].output?.output_id)
						if ((index === 0 && (status.has("ZMON") && status.has("SINET"))) || (index ===1 && (status.has("Z2ON") && status.has("Z2NET")) )) { 
							if (!op && control[1].state.status !== "selected"){
								control[1].state.status = "selected"
								control[1].update_state({supports_standby :false , status : "selected"})
								
								await create_avr_zone(avr,index)		
							}
						} else if(index == 2 ){
							let s = [...status]
							let MV = s.find(o => o.includes ("MS")) 
							if (!control[1]?.state?.display_name?.includes(MV.slice(2)))
							control[1].state.display_name  = MV.slice(2)
							control[1].update_state({display_name :  avr.name + " ♫ " + to_title_case(MV.slice(2)), supports_standby :true, status : "indeterminate"})
						}
						else {
							control[1].state.status = "deselected"
							control[1].update_state({supports_standby :true, status : "deselected"})
							if (control[1].output ){
								svc_transport.ungroup_outputs([control[1]?.output.output_id])
								delete control[1].output 
								rheos_outputs.delete(control[1].output?.output_id)
							}	
						}
					if (op && index == 0){
						let MV = s.search(/MV\d/) 
						const level= s.slice(MV+2,MV+4)
						if (level && level !== op?.volume.value ){
							svc_transport.change_volume(op,'absolute',level)
						}	
						if (status.has("MUON")){
							svc_transport.mute(op,'mute')
						} else if (status.has("MUOFF")){
							svc_transport.mute(op,'unmute')
						}
					} else if (op && index == 1){
						let Z2VOL = s.search(/Z2\d/)
						const level = s.slice(Z2VOL+2,Z2VOL+4)
						if (level && level !== op?.volume.value){
							svc_transport.change_volume(op,'absolute',level)
						}
						if (status.has("Z2MUON")){
							svc_transport.mute(op,'mute')
						} else if (status.has("Z2MUOFF")){
							svc_transport.mute(op,'unmute')
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
async function avr_zone_off(pid,index){
	const control = avr_zone_controls[(Math.abs(pid)+index).toString()]
	const avr = rheos_players.get(pid)
	if (!avr_control || !avr?.output || !avr.status){	
		return  
	} 
	if (index == 1){
		(avr.status.includes("ZMOFF") && avr.status.includes("SINET")) || (await control_avr( avr.ip,  "ZMOFF" ))
	} else {
		(avr.status.includes("Z2OFF")&& avr.status.includes("Z2NET")) || await control_avr( avr.ip,  "Z2OFF" )
	}
	control.update_state({supports_standby: true, status :"deselected" })
	control.state.status = "deselected"
}
async function create_avr_zone(avr,index){	
	const hex = ((Math.abs(avr?.pid)+(index+1)).toString(16))
	if (! rheos.processes[hex]){
		const mac = "bb:bb:"+ hex.replace(/..\B/g, '$&:').slice(-11)
		rheos.processes[hex] = await spawn(squeezelite,["-M", index === 0?  avr?.name + "​ Main​ Zone": avr?.name + "​ Zone​ 2","-m", mac,"-o","-","-Z","192000"])
	}
	return	
}
async function create_avr_controls(player){	
	player = rheos_players.get(player.pid)
	log && console.log("CREATING AVR CONTROLS FOR",player.name)
	if (player){
		for  (let index = 1; index < 3; index++) {
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
							console.log("PLAY",this .state.display_name)
						}
						req.send_complete("Success")						
					},  
					standby:  async function (req) {
					    avr_zone_controls[(Math.abs(player.pid)+index).toString()].update_state({ status : "indeterminate"})
						avr_zone_controls[(Math.abs(player.pid)+index).toString()].state.status = "standby"
						block_avr_update = true
						await control_avr( this.state.ip,this.state.index == 1 ?  "SINET" : "Z2NET" ).catch(()=>{console.log("ERROR SETTING AVR TO NETWORK")})
						await control_avr( this.state.ip,this.state.index == 1 ?  "ZMON" : "Z2ON" ).catch(()=>{console.log("ERRORSETTING AVR POWER")})
						block_avr_update = false
						await update_avr_status(rheos_players.get(this.state.pid)).catch(()=>{console.log("ERROR UPDATING AVR STATUS")})
						req.send_complete("Success")
					}
				}	
				if (! avr_zone_controls[(Math.abs(player.pid)+index).toString()]){
					avr_zone_controls[(Math.abs(player.pid)+index).toString()]	= svc_source_control.new_device(controller)	
				} else {
					avr_zone_controls[(Math.abs(player.pid)+index).toString()]?.state 
				}
				const state = controller.state
				avr_zone_controls[(Math.abs(player.pid)+index).toString()].state = state
			}
		}
		let volume_control = {
				state: {
					control_key: player.pid,
					display_name: player.name,
					volume_type:  "incremental",
					player : player
				},
				set_volume: async function (req, mode, value) {
					block_avr_update = true
					await update_avr_volume(this.state.player,mode,value)
					req.send_complete("Success");
					block_avr_update = false

				},
				set_mute: async function (req, mode	) {
					block_avr_update = true
					await update_avr_volume(this.state.player,mode)
				   	req.send_complete("Success");
					block_avr_update = false
			}
		
		
	}
		log && console.log("CREATING VOLUME CONTROL",player.name,player.pid)
		avr_volume_controls[player.pid] || (avr_volume_controls[player.pid] = svc_volume_control.new_device(volume_control))	

			if (avr_zone_controls[(Math.abs(player.pid)).toString()]) {

				console.log("ALREADY CREATED",avr_zone_controls[(Math.abs(player.pid)).toString()])
			}
			else {
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
						avr_control = 2
						block_avr_update = true
						await update_control(this.state.name,this.state.ip,this.state.display_name).catch(() => {console.log("ERROR STANDING BY",this.state.display_name)})	
						req.send_complete("Success")
						avr_control = 1
						block_avr_update = false
					}
				}
				if (avr_zone_controls[(Math.abs(player.pid)+3).toString()] ) {
					console.log("ALREADY CREATED SOUND CONTROLLER")
				} else {
					console.log("CREATING SOUND MODE ",controller.state.display_name)
					avr_zone_controls[(Math.abs(player.pid)+3).toString()]	= svc_source_control.new_device(controller)
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
	console.log("TRYING TO KILL",pid)
	const hex = (pid.toString(16))	
	console.log(hex)
	console.log(Object.keys(rheos.processes))
	if (rheos.processes[hex]){
		console.log("KILL",rheos.processes[hex]?.pid)
		process.kill( Number(rheos.processes[hex]?.pid),'SIGKILL') 
		delete rheos.processes[hex]
	}	
	return
}
async function update_outputs(outputs,added,zone,avr,player){
	return new Promise(async function (resolve,reject) {
		for await (let op of outputs) {	
			if (Array.isArray(op?.source_controls)){
				op.source_controls === false && console.error(new Date().toLocaleString(),"⚠ NO SOURCE CONTROLS",op)
				const op_name = get_output_name(op) 
				const old_op = rheos_outputs.get(op.output_id)
				const is_fixed = op.source_controls[0].display_name.includes("🔗")
				const diff = op.volume?.value - old_op?.volume?.value
				if (op_name.includes("​")){
					player = (op_name &&  await get_player_by_name(op_name.split("​",1)[0])) || undefined
				} else 	if (player = (op_name &&  await get_player_by_name(op_name)) || undefined){
					player.output = op.output_id
					op.player = player
				} 
				if (diff || (op.volume?.is_muted !== old_op?.volume?.is_muted)){
					if (is_fixed){ 
					    const zone = svc_transport.zone_by_output_id(op.output_id)
						const group = [...fixed_groups.values()].find(fixed => fixed.sum_group == get_zone_group_value(zone))
						if (group) {
						  group?.gid &&  await update_group_volume(op,group,old_op?.volume?.value !== op.volume.value,old_op?.volume.is_muted !== op.volume.is_muted)
						}
					}
					else if (player?.type === "AVR" && avr_control) {
						if (op_name && op_name.includes('​')){
							const control  = Object.values(avr_zone_controls).find(o => o.state.display_name == get_output_name(op))
							control.output = op
							if (op.volume.value !== old_op?.volume?.value) {
								player?.ip && control_avr(player.ip,(control.state.index === 1 ? "MV" : "Z2")+op.volume.value)
							}
							if (op.volume.is_muted !== old_op?.volume?.is_muted) {
								player?.ip &&  control_avr(player.ip,(control.state.index === 1 ? "MU" : "Z2MU")+(op.volume.is_muted ? "ON" : "OFF"))
							}
						}
					}
					else if (get_player_by_name(player?.name) && op?.volume?.value !== player?.volume?.level || (op?.volume?.is_muted !== (player?.volume?.mute == 'on'))) {       
							await update_volume(op,player)	
					}
				}	
				rheos_outputs.set(op.output_id,op)
			} else {
				rheos_outputs.delete(op)
			}	
			resolve()
		}
	}).catch(err => console.error(new Date().toLocaleString(),"ERROR UPDATING UOUTPUTS",err))
}
async function update_zones(zones){
	return new Promise(async function (resolve) {
		for (const z of zones) {	
			if (z.outputs ){
				const op = z.outputs[0]
				const name = get_output_name(z.outputs[0])
				const old_zone =  rheos_zones.get(z?.zone_id)
				const fixed = ([...fixed_groups.values()].find(group => z.outputs[z.outputs.length -1]?.source_controls[0].display_name == group.display_name));
				const index =   (z.outputs.findIndex(o => o.source_controls[0].status == "standby"))
				if (index === 0 ){	
					let player = rheos_outputs.get(op.output_id)?.player
					if (Array.isArray(player?.PWR)){
						block_avr_update = true
						player.PWR = await control_avr(player?.ip,"PW?")
						if (Array.isArray(player.PWR) && player.PWR.includes("PWSTANDBY")){
							await control_avr(player.ip,"PWON")
						} else {
							await control_avr(player.ip,"PWSTANDBY")
						}
						block_avr_update = false
					} 
					svc_transport.ungroup_outputs(z.outputs)
				} else if ( avr_control && z.outputs.length == 1 && name.includes("​")){
					const control  = Object.values(avr_zone_controls).find(o => o.state.display_name == name)
					if (control){
						let {update_state, state : {pid,index,status,display_name,control_key}} = control
						if (status === "deselected"){
							!op.display_name || op.display_name == "Unnamed" || await kill_avr_output((Math.abs(control.state.pid)+(control.state.index)))
							update_state({supports_standby: true, status :"standby" })
							status = "deselected"
						}  
						else if (avr_control &&  status === "selected" && rheos_players.get(pid)){
							const  group = svc_transport.zone_by_output_id(rheos_players.get(pid).output)?.outputs
							group && group.push(z.outputs[0])
							group && svc_transport.group_outputs(group)
						}
					}
				}
				else if (index > 0) {
					const op_name = get_output_name(z.outputs[index])
					if(op_name.includes("​")){
						const control  = Object.entries(avr_zone_controls).find(o=> o[1].state.display_name == op_name	)		
						if (control){
							let {state : {pid,ip,index}} = control[1]	
							let avr_status = rheos_players.get(pid).status
							if (index == 1 && avr_status.findIndex(o => o == "SINET")>-1 || index == 2 &&  avr_status.findIndex(o => o == "Z2NET")>-1 ){
								await control_avr(ip,index == 1 ? "ZMOFF" : "Z2OFF")
							}
						}		
					}
				}
				if (fixed_control && fixed?.gid){
					const op = z.outputs[0]
					let zone_outputs = fixed.players.sort((a, b) => {let fa = a.role == "leader" ? 0 : 1; let fb = b.role == "leader" ? 0 : 1; return fa - fb} ).map(player => rheos_outputs.get(rheos_players.get(player.pid)?.output))
					zone_outputs.push(op)
					zone_outputs = zone_outputs.filter(Boolean)
					if (((z.state == "playing" || z.state == "loading") && z.now_playing) && z.outputs.length == 1 ){
						svc_transport.transfer_zone( z,svc_transport.zone_by_output_id(zone_outputs[0].output_id))
						svc_transport.control(svc_transport.zone_by_output_id(zone_outputs[0].output_id),"play")
						group_pending.length = 0
						group_pending.push([z,zone_outputs[0].output_id])
					}
					if (group_pending.length && (z.outputs.findIndex(o => o.output_id == group_pending[0][1] >-1)) && z.now_playing && z.now_playing?.one_line.line1 == group_pending[0][0]?.now_playing?.one_line.line1 ) {
						svc_transport.group_outputs(zone_outputs)
					}
					if (group_pending.length && (get_zone_group_value(z) == fixed.sum_group) && ([...rheos_groups.values()].findIndex(o => o.sum_group == fixed.sum_group)>-1)){
                        if (z?.is_play_allowed && z?.state !== "playing" && z?.state !== "loading") {
							svc_transport.control(z,"play")	
						} else if (z.state == "playing"){
							group_pending.shift()
						}	
					}
					if (!group_pending.length && fixed?.gid && (z.state == "paused" || z.state == "stopped" )  && z.outputs.length >1 ){
						svc_transport.ungroup_outputs(z.outputs)
					}	   
				}	
				const group = (rheos_groups.get(get_pid(z.outputs[0]?.source_controls[0]?.display_name)))
				const old_roon_group = old_zone?.outputs?.map(output => get_pid(output?.source_controls[0]?.display_name))
				const new_roon_group = (z.outputs.map(output => get_pid(get_output_name(output))))
				const heos_group = group?.players.map(player => player.pid);
				if (z.outputs.length > 1 && (sum_array(old_roon_group) !== sum_array(new_roon_group))  && (sum_array(new_roon_group) !== sum_array(heos_group))){
					await group_enqueue(new_roon_group)
				}	
				z.group = group 
				rheos_zones.set(z.zone_id,z)
	        	fixed && z.outputs.length == 1 || z.state == 'paused' || z.state == 'stopped' || (old_zone?.now_playing?.one_line?.line1 == z?.now_playing?.one_line?.line1 ) ||  console.error(new Date().toLocaleString(), z.display_name, " ▶ ",z?.now_playing?.one_line?.line1)
			} else { 
				const zone =(rheos_zones.get(z))
				if (zone?.outputs.filter(op => op && get_pid(get_output_name(op))).length >1){
					const lead_player_pid = get_pid(zone.outputs[0]?.source_controls[0]?.display_name)
					const group = (rheos_groups.get(lead_player_pid))
					if (group?.gid) {
						await group_enqueue(lead_player_pid)
					}
				} 
				rheos_zones.delete(zone?.zone_id || z)	
			}
		resolve()
		}
	}).catch(err => console.error(new Date().toLocaleString(),err))
}
async function update_volume(op,player){
	if (!op?.volume){return}
	let {is_muted,value} = op.volume
	if (!player?.volume){return}
	let {mute = "off",level = 0} = player?.volume 
	if ((value || value === 0) && level !== value) {
		await heos_command("player", "set_volume", { pid: player?.pid, level: value }).catch(err => console.error(new Date().toLocaleString(),err))
	}
	if ((mute == 'on' !== is_muted  )) {
		await heos_command("player", "set_mute", { pid: player?.pid, state: is_muted ? "on": "off"}).catch(err => console.error(new Date().toLocaleString(),err))
	}
	return
}
async function update_avr_volume(player,mode,value){   
	if (mode == 'relative'){
		await heos_command("player", value == 1 ? "volume_up" : "volume_down", { pid: player?.pid, step: 1 }).catch(err => console.error(new Date().toLocaleString(),err))
		let zone = (svc_transport.zone_by_output_id(player.output))
		for (let o of zone.outputs){
            if (get_output_name(o).includes("​")){
				svc_transport.change_volume(o,mode,value)
			}
		}
	} 
	else if (mode == 'toggle'){
		await heos_command("player", "toggle_mute",{ pid: player?.pid}).catch(err => console.error(new Date().toLocaleString(),err))
        let zone = (svc_transport.zone_by_output_id(player.output))
		for (let o of zone.outputs){
            if (get_output_name(o).includes("​")){
				svc_transport.mute(o,o.volume.is_muted ? 'unmute' : 'mute')
			}
		}	
	} 
	return
}
async function update_group_volume(op,group,vol,mute){
	vol && heos_command("group", "set_volume", { gid: group.gid, level: op.volume.value }).catch(err => console.error(new Date().toLocaleString(),err))
	mute && heos_command("group", "set_mute", { gid: group.gid, state: op.volume.is_muted ? "on" : "off" }).catch(err => console.error(new Date().toLocaleString(),err))
}
async function heos_command(commandGroup, command, attributes = {}, timer = 5000) {
	if (!rheos_connection) {
		console.error(new Date().toLocaleString(),"⚠ NO CONNECTION")
		return
	}
	typeof attributes === "object" || ((timer = attributes), (attributes = {}))
	return new Promise(function (resolve, reject) {
		setTimeout(() => {reject(`Heos command timed out: ${command} ${timer}`) }, timer)
		commandGroup !== "event" && rheos_connection[0].write(commandGroup, command, attributes)
		rheos_connection[0].once({ commandGroup: commandGroup, command: command, attributes }, (res) => {
			res.parsed = res.heos.message.parsed
			res.result = res.heos.result
			if (res.heos.message.unparsed.includes("under process")) {
				rheos_connection[0].once({ commandGroup: commandGroup, command: command, attributes }, (res) => {
				resolve(res)
			})} 
			else if (res.heos.result === "success") {
				resolve(res)}
			else {
				reject(res)	
			}		
		})
	}).catch((err)=> err)
}
async function build_templates() {
	devices.xml_template = {}
	devices.template = {
		"squeeze2upnp": {
			"common": [
				{
					"enabled": ['0'],
					"streambuf_size": [mysettings.streambuf_size],
					"output_size": [mysettings.output_size],
					"stream_length": [mysettings.stream_length],
					"codecs": ["aac,ogg,flc,alc,pcm,mp3"],
					"forced_mimetypes": ["audio/mpeg,audio/vnd.dlna.adts,audio/mp4,audio/x-ms-wma,application/ogg,audio/x-flac"],
					"mode": [("flc:0,r:-48000,s:16").toString().concat(mysettings.flow ? ",flow" : "")],
					"raw_audio_format": ["raw,wav,aif"],
					"sample_rate": ['48000'],
					"L24_format": ['2'],
					"roon_mode": ['1'],
					"seek_after_pause": [mysettings.seek_after_pause],
					"volume_on_play": [mysettings.volume_on_play],
					"flac_header": [mysettings.flac_header],
					"accept_nexturi": [mysettings.accept_nexturi],
					"next_delay": [mysettings.next_delay],
					"keep_alive": [mysettings.keep_alive],
					"send_metadata": [mysettings.send_metadata],
					"send_coverart": [mysettings.send_coverart],
					"flow":[mysettings.flow],
					"log_limit":[mysettings.log_limit]
				}
			],
			"device": []
		}
	}
}
async function build_devices(player) {
	log && console.log("BUILDING DEVICES")
	return new Promise(async function (resolve) {
		let data = await (fs.readFile('./UPnP/Profiles/config.xml', 'utf8'))
		xml2js.parseString(data, async (err, result) => {
			if (err) { throw err }
			if (!result?.squeeze2upnp?.device?.entries()) {
				console.error(new Date().toLocaleString(),"⚠ NO DEVICE ENTRIES")
				return
			}
		if (player){
			let device = result?.squeeze2upnp?.device.find(o => o.name == player.name)
			console.log("RESETTING PLAYER RESOLUTION",player.name,player.resolution)
			set_player_resolution(device,player)
		} else {for await (const [index, device] of result?.squeeze2upnp?.device?.entries()) {
			let player = await get_player_by_name(device.name[0])
			if (player){
				set_player_resolution(device,player)	
				}
			else {
				delete result.squeeze2upnp.device[index]
			}
			result.squeeze2upnp.common[0] = devices.template.squeeze2upnp.common[0]
			result.squeeze2upnp.common[0].enabled = ['0']
			delete result.squeeze2upnp.slimproto_log
			delete result.squeeze2upnp.stream_log
			delete result.squeeze2upnp.output_log
			delete result.squeeze2upnp.decode_log
			delete result.squeeze2upnp.main_log
			delete result.squeeze2upnp.util_log
			delete result.squeeze2upnp.log_limit
			result.squeeze2upnp.device = result.squeeze2upnp.device
			devices.xml_template = builder.buildObject(result)
			await fs.writeFile("./UPnP/Profiles/config.xml", devices.xml_template).catch(()=>{console.error(new Date().toLocaleString(),"⚠ Failed to save config")})
			rheos.mode = false
			}	
		}
		resolve()
		})
	})
}
async function set_player_resolution(device,player){
	let resolution = player.resolution;
    switch (resolution) {
	case  ( "HR") :{
		device.enabled = ['1']
		device.mode = ("flc:0,r:192000,s:24").toString().concat(mysettings.flow ? ",flow" : "")
		device.sample_rate = ['192000']
	} 
	break
	case  ( "THRU" ) : {
		device.enabled = ['1']
		device.mode = "thru"
		device.sample_rate = ['192000']
	}
	break
	default :
		device.enabled = ['1']
		device.mode = ("flc:0,r:48000,s:16").toString().concat(mysettings.flow ? ",flow" : "")
		device.sample_rate = ['48000']
	}
	let subtemplate = { "squeeze2upnp": { "common": devices.template.squeeze2upnp.common, "device": [device] } }
	devices.xml_template = builder.buildObject(subtemplate)
	await fs.writeFile("./UPnP/Profiles/" + (device.name[0]) + ".xml", devices.xml_template).catch(()=>{console.error(new Date().toLocaleString(),"⚠ Failed to create template for "+device.name[0])})
	await create_player(player.pid)
	myplayers.find(o => o.pid == player.pid).resolution = resolution
	roon.save_config("settings",mysettings);
	roon.save_config("players",[...rheos_players.values()].map((o) => {let {Z2,PWR,volume,output,zone,state,status,group, ...p} = o;return(p)}));
}
async function start_listening() {
	setInterval(()=> {paired && update_status(false,false)},5000)
	await heos_command("system", "prettify_json_response", { enable: "on" }).catch(err => console.error(new Date().toLocaleString(),"⚠ Failed to set responses"))
}
async function choose_binary(name, fixed = false) {
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
			process.exit(0)
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
		  	process.exit(0)
		}
	}
	else {
		console.error(new Date().toLocaleString(),"⚠ THIS OPERATING SYSTEM IS NOT SUPPORTED");
	 	process.exit(0)
	}
}
async function group_enqueue(group) {
	Array.isArray(group) && (group = group.filter(o => o))
	if (!group) {
		return 
	}
	return new Promise(async (resolve, reject) => {
		group_buffer.push({ group, resolve, reject })
		group_dequeue().catch((err)=>{log && console.error(new Date().toLocaleString(),"Deque error",err)})
	})
}	
async function group_dequeue(timer = 30000) {
	if (rheos.working || !group_buffer.length) { 
		return }
	const item = group_buffer[0]
	if (!item) {
		return
	}
	try {
		rheos.working = true
		await heos_command("group", "set_group", { pid: item?.group?.toString() },timer).catch((err) => {item.reject(err); rheos.working = false; group_dequeue() })
		rheos.working = false 
		group_buffer.shift()
		item.resolve()
		await group_dequeue()
	}
	catch (err) {
		rheos.working = false
		group_buffer.shift()
		item.reject(err)
		await group_dequeue()
	}
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
			svc_transport.ungroup_outputs(rheos_zones.get((rheos_players.get(remove[0])?.zone))?.outputs)
		} else {
            const remove = old_groups
			svc_transport.ungroup_outputs(rheos_zones.get((rheos_players.get(remove[0])?.zone))?.outputs)
		}
		await get_all_groups()
		resolve()
	}).catch(err => console.error(new Date().toLocaleString(),err))
}
async function connect_roon() {
	return new Promise(async function (resolve,reject) {
	const timer = setInterval(() => console.warn(" ⚠ Please ensure RHEOS is enabled in Settings -> Extensions"), 10000)
	const roon = new RoonApi({
		extension_id: "com.RHeos.beta",
		display_name: "Rheos",
		display_version: "0.8.4-0",
		publisher: "RHEOS",
		email: "rheos.control@gmail.com",
		website: "https:/github.com/LINVALE/RHEOS",
		log_level: "none",
		core_paired: async function (core) {
			log && console.log(new Date().toLocaleString()+ " ROON PAIRED",roon.extension_reginfo.extension_id)
			clearInterval(timer)
			paired = true
			svc_transport = core.services.RoonApiTransport
			svc_transport.subscribe_outputs(async function (cmd, data) {		
				switch (cmd){
					case "Subscribed" : 
						for await (const o of data.outputs) {
							if (Array.isArray(o?.source_controls)){
								Array.isArray(data.outputs) &&  await update_outputs(data.outputs,true)
								let player = await get_player_by_name(o?.source_controls[0]?.display_name);
								player && (player.output = o.output_id)
								o.player = player
								console.log("SUBSCRIBING",o.display_name,o.output_id)
						    	rheos_outputs.set(o.output_id, o)
								player && rheos_players.set(player.pid,player)
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
					case "NetworkError" : {console.error(new Date().toLocaleString(),'⚠',"SUBSCRIBED OUTPUT ERROR",cmd,data)
					}
					break
					default: console.error(new Date().toLocaleString(),'⚠',"SUBSCRIBED OUTPUT UNKNOWN ERROR",cmd,data)	
				}
			})
			svc_transport.subscribe_zones(async function (cmd, data) {
				switch(cmd){
					case "Subscribed" : 
						for await (const z of data.zones) {
							 get_player_by_name(z.display_name) &&	rheos_zones.set(z.zone_id, z)  
						}
						Array.isArray(data.zones_subscribed) && await update_zones(data.zones_subscribed,true)
					case "Changed" : {	
						if (Array.isArray(data.zones_added)){
							for await (const z of data.zones_added) {
								await get_player_by_name(z.display_name) &&	rheos_zones.set(z.zone_id, z)  
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
			log && console.log("⚠ UNPAIRED")
            paired = false
			core = undefined
		}
	})
	if (roon){
		resolve (roon)
	}else{
		console.error(new Date().toLocaleString(),"⚠ NO ROON API FOUND PLEASE CHECK YOUR ROON SERVER IS SWITCHED ON AND ACCESSIBLE AND TRY AGAIN");
		reject
	}
})
}
async function update_status(message = "",warning = false){
	let RheosStatus = rheos_players.size + " HEOS Players on " + system_info[2] +" "+ system_info [3]+" "+ system_info [4] + ' at ' + system_info[0] + '  for ' + get_elapsed_time(start_time) + '\n'
    if (rheos.mode){
		RheosStatus = RheosStatus + "_".repeat(150) + " \n \n " + (rheos.discovery > 0 ? ("⚠      UPnP CONNECTING       " + ("▓".repeat((rheos.discovery < 49 ? rheos.discovery : 50))+"░".repeat(50-(rheos.discovery <49 ? rheos.discovery : 50))))
		: ("DISCOVERED " + rheos_players.size + " HEOS PLAYERS")) + "\n \n"
		for (let player of rheos_players.values()) {
		const { name, ip, model } = player
		let quality = (mysettings[player.name])
		RheosStatus = RheosStatus + (rheos.discovery ? "◐◓◑◒".slice(rheos.discovery % 4, (rheos.discovery % 4) + 1) + " " : (quality === "HR")  ?"◉  " :"◎  " ) + name?.toUpperCase() + " \t " + model + "\t" + ip + "\n"
		}	
	}
	for (let zone of [...rheos_zones.values()].filter(zone => (get_player_by_name(zone.outputs[0]?.display_name) &&!get_output_name(zone.outputs[0]).includes("🔗") && zone.state ==="playing") )) {	
		RheosStatus = RheosStatus + (zone.outputs.length == 1 ?"🎵 ":"🎶  ") + (zone.fixed?.zone?.output || zone.display_name) + "\t ▶ \t" + zone.now_playing?.one_line?.line1 + "\n"
	}
	message && (RheosStatus = RheosStatus + "\n \n" + message)
	svc_status.set_status(RheosStatus,warning)
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
	l.layout.push({ title: "Enable AVR Zone Control ", type: "dropdown", setting: 'avr_control', values : [{title: "ON", value : true},{title : "OFF", value :false}]})
	l.layout.push({ title: "Enable Fixed HEOS Groups ", type: "dropdown", setting: 'fixed_control', values : [{title: "ON", value : true},{title : "OFF", value :false}]})
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
	if (mysettings.avr_control){
		let _avrs = { type: "group", title: "RECEIVERS", subtitle: "Set default mode for Denon/Marantz AVRs", collapsable: true, items: [] };
		for (let player of rheos_players) {
			if (player[1].type === "AVR") {
				let values = []
				sound_modes.forEach(mode => values.push({value: mode, title: to_title_case(mode.slice(2)) }))
				_avrs.items.push({title: player[1].name,type: "dropdown",values: values, setting: "M"+player[1].pid.toString()})
			}
		}
		l.layout.push(_avrs)
	}
	if (mysettings.fixed_control){
		let _fixed_groups = { type: "group", title: "GROUPS", subtitle: "Create fixed groups of players", collapsable: true, items: [] };
		_fixed_groups.items.push(
			{ title: "Max Safe Fixed_Group Volume", type: "integer", setting: 'max_safe_vol', min: 0, max: 100 }	
		)
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
		
		{ title: "● Buffer Size", type: "dropdown", setting: 'streambuf_size', values: [{ title: "Small", value: 524288 }, { title: "Medium", value: 524288 * 2 }, { title: 'Large', value: 524288 * 3 }] },
		{ title: "● Output Size", type: "dropdown", setting: 'output_size', values: [{ title: 'Small', value: 4194304 }, { title: 'Medium', value: 4194304 * 2 }, { title: 'Large', value: 4194304 * 3 }] },
		{ title: "● Stream Length", type: "dropdown", setting: 'stream_length', values: [{ title: "no length", value: -1 }, { title: 'chunked', value: -3 }] },
		{ title: "● Seek After Pause", type: "dropdown", setting: 'seek_after_pause', values: [{ title: "On", value: 1 }, { title: 'Off', value: 0 }] },
		{ title: "● Volume On Play", type: "dropdown", setting: 'volume_on_play', values: [{ title: "On Start Up", value: 0 }, { title: 'On Play', value: 1 }, { title: "Never", value: -1 }] },
		{ title: "● Volume Feedback", type: "dropdown", setting: 'volume_feedback', values: [{ title: "On", value: 1 }, { title: 'Off', value: 0 }] },
		{ title: "● Accept Next URI", type: "dropdown", setting: 'accept_nexturi', values: [{ title: "Off", value: 0 }, { title: 'Force', value: 1 }, { title: "Manual", value: -1 }] },
		{ title: "● Flac Header", type: "dropdown", setting: 'flac_header', values: [{ title: "None", value: 0 }, { title: 'Set sample and checksum to 0', value: 1 }, { title: "Reinsert fixed", value: 2 }, { title: "Reinsert calculated", value: 3 }] },
		{ title: "● Keep Alive", type: "integer", setting: 'keep_alive', min: -1, max: 120 },
		{ title: "● Next Delay", type: "integer", setting: 'next_delay', min: 0, max: 60 },
		{ title: "● Send Metadata", type: "dropdown", setting: 'send_metadata', values: [{ title: "On", value: true }, { title: 'Off', value: false }] },
		{ title: "● Send Cover Art", type: "dropdown", setting: 'send_coverart', values: [{ title: "On", value: true }, { title: 'Off', value: false }] },
		{ title: "● Flow Mode", type: "dropdown", setting: 'flow', values: [{ title: "On", value: 1 }, { title: 'Off', value: 0 }] },
		{ title: "● Log File Size Limit (MB) -1 for unlimited", type: "integer", setting: 'log_limit', min: -1, max: 10 },
		{ title: "● ROON UPnP Server Address", type: "string",  maxlength: 15, setting: "upnp_ip" }
	]
	})
	l.layout.push({
		type: "group", title: "RESET" , subtitle :" Changes are irreversible, use with caution", collapsable: true, items: [
			{ title: "● RESET STATUS TO DEFAULTS", type: "dropdown", setting: 'clear_settings', values: [{ title: "YES", value: true}, { title: "NO", value: false}] },
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
	if (rheos_players.size && typeof player_name === 'string') {
		let player = [...rheos_players.values()].find((player) => player?.name?.trim().toLowerCase() === player_name?.trim().toLowerCase())
		return player?.pid || 0
	}
}
function get_output_name(output){
	return (output?.source_controls? output.source_controls[0]?.display_name : undefined)
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
		exec("pkill -f -9 UPnP")
		exec("pkill -f -9 squeezelite")
		process.exit(0);	
    };
    process.on('SIGTERM', handle);
    process.on('SIGINT', handle);
}
function get_player_by_name(player_name) {
	return [...rheos_players.values()].find((player) => player?.name?.trim().toLowerCase() === player_name?.trim().toLowerCase())
}
function to_title_case(str) {
	return str.replace(
	  /\w\S*/g,
	  function(txt) {
		return txt.charAt(0).toUpperCase() + txt.substr(1).toLowerCase();
	  }
	);
}  
