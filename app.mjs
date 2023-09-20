const version = "0.7.3-0"

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

var roon, svc_status, my_settings, svc_transport, svc_volume_control, svc_source_control, svc_settings, rheos_connection, my_players, my_fixed_groups, squeezelite, avr_control,fixed_control,fixed_group_control = {};
const fixed_groups = new Map()
const all_groups = new Map()
const system_info = [ip.address(), os.type(), os.hostname(), os.platform(), os.arch()]
const rheos = { processes: {}, mode: false, discovery: 0, working: false, avr : {} , has_avr : false}
const start_time = new Date()
const group_buffer = []
const avr_buffer = {}
const execFileSync = util.promisify(child.execFile);
const exec = (child.exec)
const spawn = (child.spawn)
const rheos_players = new Map()
const rheos_zones = new Map()
const rheos_outputs = new Map()
const rheos_groups = new Map()
const play_pending = new Map()
const group_pending =[]
const avr_zone_controls = {}
const rheos_connect = RheosConnect.Telnet
const builder = new xml2js.Builder({ async: true })
const devices = {}
const log = process.argv.includes("-l")||process.argv.includes("-log") 
const sound_modes = ["MSSTEREO","MSDIRECT","MSPURE DIRECT","MSMCH STEREO","MSVIRTUAL","MSUSE LAST SELECTED"]
init_signal_handlers()
start_up()
async function start_up(){
	exec("pkill -f -9 UPnP")
	exec("pkill -f -9 squeezelite")
    squeezelite = "squeezelite"
	await start_roon().catch(err => console.error(err))
	console.log(system_info.toString(),"Version :",roon.extension_reginfo.display_version)
	const c = spawn("squeezelite")
		c.on('error', async function(err) {
		log && console.error('SQUEEZELITE NOT INSTALLED : LOADING BINARIES');
		squeezelite = await choose_binary("squeezelite",true)
	})
	await start_heos().catch(err => console.error(err))
	await discover_devices().catch(err => {throw error(err)})
	await build_templates()
    await build_devices().catch(err => console.error("⚠ Error Building Devices",err => {throw error(err)}))
	await add_listeners().catch(err => console.error("⚠ Error Adding Listeners",err => {throw error(err)}))
	await update_heos_groups().catch(err => console.error(err))
    create_fixed_group_control()
	fixed_control && await load_fixed_groups().catch(err => console.error("⚠ Error Loading Fixed Groups",err => {throw error(err)}))
	avr_control && await create_zone_controls().catch(err => console.error("⚠ Error Creating Zone Controls",err => {throw error(err)}))
	monitor()
	setTimeout(() => {start_listening().catch(err => console.error("⚠ Error Starting Listening",err => {throw error(err)}))},10000)
}
async function monitor() {
	setInterval(async () => {
		heos_command("system", "heart_beat", {})
		.catch(err => {
			console.error("⚠  HEARTBEAT MISSED", err)
			update_status("SYSTEM ERROR",true)
		})
		update_status("",false)
	}, 1000)
	return
}
async function add_listeners() {
	log && console.error("SETTING LISTENERS")
	process.setMaxListeners(32)
	rheos_connection[0].socket.setMaxListeners(32)
	rheos_connection[1].socket.setMaxListeners(32)
	rheos_connection[1].write("system", "register_for_change_events", { enable: "on" })
		.on({ commandGroup: "system", command: "heart_beat" }, async (res) => {
			res?.heos?.result == "success" || console.error("⚠ HEARTBEAT failed", res)
		})
		.onClose(async (hadError) => {
			console.error("⚠ Listeners closed", hadError)
			if (hadError) await start_up().catch(err => { console.error(err) })
		})
		.onError((err) => console.error("⚠ HEOS REPORTS ERROR", err))
		.on({ commandGroup: "event", command: "groups_changed" }, async (pending,pending_zone) => {
			await update_heos_groups().catch(err => console.error(err))
			if (group_pending.length){
				pending_zone = svc_transport.zone_by_output_id(group_pending[0][1])
				pending = get_zone_group_value(pending_zone)
			}
			for (const group of [...rheos_groups.values()]) {
				if (pending == group.sum_group){
					svc_transport.control(pending_zone,'play')
				}
					const players =	group.players.sort((a, b) => {let fa = a.role == "leader" ? 0 : 1; let fb = b.role == "leader" ? 0 : 1; return fa - fb} )	
					const zone = rheos_zones?.get(rheos_players.get(group.gid)?.zone);
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
			log && console.log("⚠ PLAYERS HAVE CHANGED - RECONFIGURING")
			setTimeout(async ()=>{await compare_players()},1000)
		})
		.on({ commandGroup: "event", command: "player_playback_error" }, async (res) => {
			if ( res.heos.message.parsed.error.includes("Unable to play media")){
				svc_transport.control(rheos_players.get(res.heos.message.parsed.pid)?.zone, 'play')
			}
			else {
				console.error("⚠ PLAYBACK ERROR - ATTEMPTING TO PLAY AGAIN", res.heos.message.parsed.error)
				svc_transport.control(rheos_players.get(res.heos.message.parsed.pid)?.zone, 'play')
			}
		})
		.on({ commandGroup: "event", command: "player_volume_changed" }, async (res) => {
			const { heos: { message: { parsed: { mute, level, pid } } } } = res, player = rheos_players.get(pid)
			if (player?.volume && (mute != player.volume.mute)) {
				player.volume.mute = mute
				await svc_transport.mute(player.output, (mute == 'on' ? 'mute' : 'unmute'))
			}
			if (player?.volume && level !== player?.volume?.level) {
				player.volume.level = level
				await svc_transport.change_volume(player.output, 'absolute', level)
			}
		})
		.on({ commandGroup: "event", command: "group_volume_changed" }, async (res) => {
			const { heos: { message: { parsed: { gid } } } } = res, group = rheos_players.get(gid)
			if (group?.players){
				for (let player of group.players){
					const res = await heos_command('player','get_volume',{pid : player.pid})
					const op = (rheos_players.get(player.pid).output)
					svc_transport.change_volume(op, 'absolute', res.parsed.level)
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
					await monitor()
					rheos.discovery=0
					rheos.mode = false
					resolve()
				} else {
					log && console.error("DIFFERENT PLAYERS")
					throw error
				}
			} catch {
				log && console.error("UPDATING CONFIG")
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
	log && console.error("CREATING ROOT XML")
	const app = await (choose_binary("SYSTEM")).catch(() =>{
		log && console.error("⚠ BINARY NOT FOUND")
		setTimeout(()=>{process.exit(0)},500)
	})
	return new Promise(async function (resolve,reject) {	
		try {
			log && console.error("CREATING CONFIG FROM IP", system_info[0])
			rheos.mode = true
			let app = await choose_binary(system_info)	
			try {
			  	await execFileSync(app, ['-i', './UPnP/Profiles/config.xml', '-b', system_info[0]])
			} catch (err) {
				console.log("ERROR",err);
			}
			resolve()
		} 
		catch {
			reject(err)
		}
	})
}
async function start_heos(counter = 0) {
	log && console.log("STARTING HEOS")
	rheos_connection || (rheos_connection = await  Promise.all([HeosApi.discoverAndConnect({timeout:10000,port:1255, address:system_info[0]}),HeosApi.discoverAndConnect({timeout:10000,port:1256, address:system_info[0]})]))
	try {
		rheos_connection[0].socket.setMaxListeners(32)
		rheos_connection[1].socket.setMaxListeners(32)
		const players = await get_players().catch(()=>{console.error("⚠ Unable to discover Heos Players");throw new Error('Unable to Get Heos Players');})
		for (let player of players) {
			if (!player.ip) {
				rheos_connection = undefined
				throw new Error()
			} 
			player.resolution = my_players.find(p => p.pid == player.pid)?.resolution || my_settings[player.pid] || 'CD'
			player.volume = {}
			player.type = my_players.find(p => p.pid == player.pid)?.type || ""
			player.pid && rheos_players.set(player.pid, player)
			fs.access('./UPnP/Profiles/' + player.name + '.log').then(() => fs.truncate('./UPnP/Profiles/' + player.name + '.log', 0)).catch(()=> {})
		}
		players.sort((a, b) => {
				let fa = a.network == "wired" ? 0 : 1
				let fb = b.network == "wired" ? 0 : 1
				return fa - fb
		})
		console.table(players, ["name", "pid", "model", "ip", "resolution","network"])
	
		return 	(players)		
	}
	catch (err) {
		update_status( "⚠ SEARCHING FOR NEW HEOS PLAYERS",false)
		process.stdout.write("\rGetting Heos Players " + (".").repeat(counter)+"\n")
		if (counter == 10) {process.stdout.write("\rRHEOS IS SHUTTING DOWN          \n");process.exit(0)}
		setTimeout(() => {start_heos(++counter)}, 5000)
	}
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
					console.error("UNABLE TO GET PLAYERS",players)
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
	const old_pids = [...rheos_players.keys()]
	const new_players = await get_players().catch(() => {console.error("⚠ UNABLE TO GET PLAYERS TO COMPARE")})
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
	const player = rheos_players.get(Number(pid))
	const name = player.name
	rheos.processes[pid] && process.kill(rheos.processes[pid].pid)
	const app = await (choose_binary(name)).catch(err => console.error("Failed to find binary",err))
	rheos.processes[player.pid] = spawn(app, ['-b', system_info[0], '-Z', '-M', name,
		'-x', './UPnP/Profiles/' + name + '.xml', 
		'-p','./UPnP/Profiles/' + name + '.pid',
		'-f', './UPnP/Profiles/' + name + '.log']),
		{ stdio: 'ignore' }
	return 
}
async function load_fixed_groups(){
	fixed_groups.size &&
	[...fixed_groups.entries()].forEach( async fg => {
		if (fg && my_settings[fg[0]] && fg[1]){
			create_fixed_group(fg).catch(()=> {})
		}
	})
	return
}
async function create_fixed_group(group){
	await group_enqueue(group[0])
	const fixed = Math.abs(group[1].sum_group).toString(16);
	if (rheos.processes[fixed]?.pid){
		try { 
			console.log("KILLING",rheos.processes[fixed].spawnargs)
			process.kill( rheos.processes[fixed]?.pid,'SIGKILL') 
			fixed_groups.delete(group[0])
			await get_all_groups()
		} catch { console.error("⚠ UNABLE TO DELETE PROCESS FOR"),group}	
	}
	if (fixed_control){
    const name = group[1].name.split("+")
	const display_name = "🔗 " +name[0].trim()+" + " + (name.length -1)
	group[1].display_name = display_name
	fixed_groups.set(group[0],group[1])
	const mac = "bb:bb:bb:"+ fixed.replace(/..\B/g, '$&:').slice(1,7)
	rheos.processes[fixed] = spawn(squeezelite,["-a","24","-r",group[1].resolution +" : 500","-M",display_name,"-m", mac,"-o","-","-p","99","-W","-v"])//,"-l","9030"])
	}
	await get_all_groups()
	return
}
async function create_fixed_group_control(){
	let controller = {    
		state: {
			
			display_name: "Show Loading Status",
			supports_standby: false,
			status:  "indeterminate",
		},  
		convenience_switch : async function (req) {
			setTimeout( () => {req.send_complete("Success")},3000)
		},  
		standby:  async function (req) {
			req.send_complete("Success")				 
		}
	}
	Object.keys(fixed_group_control).length === 0 && (fixed_group_control = svc_source_control.new_device(controller))
}
async function remove_fixed_group(g) {
	const pid = (rheos.processes[Math.abs(g).toString(16)]?.pid)
	try { 
		console.log("PID",pid,"G",g,"FIX",Math.abs(g).toString(16))
		fixed_groups.delete(g)
		process.kill(pid) 
		await get_all_groups()
	}
	catch { console.error("⚠ UNABLE TO DELETE PROCESS FOR"),g}	 
   	return 
}
async function start_roon() {
	log && console.error("STARTING ROON")
	roon = await connect_roon().catch((err)=> {console.error("Failed to connect with ROON server",err)})
	svc_status = new RoonApiStatus(roon)
	svc_transport = new RoonApiTransport(roon)
	svc_source_control = new RoonApiSourceControl(roon)
	svc_volume_control = new RoonApiVolumeControl(roon)
	const def = JSON.parse(await fs.readFile('./default_settings.json','utf-8'))
	my_settings = roon.load_config("settings")|| def.settings || {}
	my_settings.log_limit || (my_settings.log_limit = 1)
	my_players = roon.load_config("players") || []
	my_players.forEach(player => my_settings[player.pid]=player.resolution)
	avr_control = my_settings.avr_control || false
	fixed_control = my_settings.fixed_control || false
	if (fixed_control){
		let  fg = roon.load_config("fixed_groups") || []
		my_fixed_groups = fg
		Array.isArray (my_fixed_groups)  &&   my_fixed_groups?.forEach(g => {g[1].state = 'paused';fixed_groups.set(g[0],g[1])})			
	}
	my_settings.clear_settings = false	
	svc_settings = new RoonApiSettings(roon, {
		get_settings: async function (cb) {
			cb(makelayout(my_settings))
		},
		save_settings: async function (req, isdryrun, settings) {
			let l = makelayout(settings.values)
			if (l.values.default_player_ip && !l.has_error) {
				await HeosApi.connect(l.values.default_player_ip, 1000).catch(err => (l.has_error = err))
			}
			if (!isdryrun && !l.has_error) {
				my_settings = l.values
				for (let fg of all_groups){					
					if (settings.values[fg[1].sum_group] !== "DELETE"){
						fg[1].resolution = settings.values[fg[1].sum_group]
						fixed_groups.set(fg[1].sum_group,fg[1])
						create_fixed_group(fg)
					} else if ((settings.values[fg[1].sum_group] == "DELETE")){
						group_enqueue(fg[1].gid)
						delete my_settings[fg[1].sum_group]
						remove_fixed_group(fg[1].sum_group)
					}
				}
				let saved_players = Object.entries(l.values).filter(o => rheos_players.get(Number(o[0])))
				for (let player in my_settings){
					let found_player = 	saved_players.find(p => p[0] == player && p[1] !== my_settings[player])
					if ( found_player) {
						rheos_players.get(Number(found_player[0])).resolution = found_player[1]
						await build_devices(found_player).catch(()=>{console.error("Failed to build devices")})
					}
				}	 
				let rebuild = Object.keys(l.values).filter(x => ! Number(x)).map(x => !x.isNumber && l.values[x] == my_settings[x])  
				if (rebuild.findIndex(x => (x == false))>-1){   
					log && console.log("REBUILDING DEVICES")
					await build_templates().catch(()=>{console.error("Failed to build templates")})
					await build_devices().catch(()=>{console.error("Failed to build devices")})
				}
				my_fixed_groups = [...fixed_groups.entries()]
				if (my_settings.clear_settings) {
					my_settings.clear_settings = false; my_settings = def.settings
				} 
				await get_all_groups()
			}
			if (fixed_control !== my_settings.fixed_control){
				fixed_control = my_settings.fixed_control
				if (!fixed_control) {
					console.log("I would delete fixed groups",fixed_groups)
					for (const [key, value] of fixed_groups){
						console.log("REMOVING",value.display_name)
						remove_fixed_group(value.sum_group)
						delete settings.values[value.sum_group]
						group_enqueue([key])
					}
					fixed_groups.clear()
				}
			}
			if (avr_control !== my_settings.avr_control){
				avr_control = my_settings.avr_control
				avr_control ? create_zone_controls() :	clear_avr_zones()
			}
			roon.save_config("fixed_groups",my_fixed_groups)
			roon.save_config("settings", my_settings)
			req.send_complete(l.has_error ? "NotValid" : "Success", { settings: l })
		}
	})
	roon.init_services({
		required_services: [RoonApiTransport], provided_services: [	svc_status,	svc_settings, svc_source_control,svc_volume_control], 
	})
	roon.start_discovery()
	return (roon)
}
async function control_avr(ip,command,req) {
    avr_buffer[ip] = []
	Array.isArray(command) && (command = command.filter(o => o))
	if (!command) {return }
	return new Promise(async (resolve, reject) => {	
	 	avr_buffer[ip].push({ item: Array(ip,command,req), resolve, reject })
		await avr_dequeue(ip).catch((err)=>{console.error("Deque error",err)})	
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
	}).catch(err => console.error("AVR Connection Error",err))
	try {
		res = await connection.write(req.item[1],{timeout : 200},(err,data)=>{err || (rheos.avr[ip] = false);connection.end()})
		res = res.split(",").filter((str) => {return /\S/.test(str)})
		res.push(req.item[0])
		if (req.req) {req.req.send_complete("Success")}
		req && req.resolve(res)	
	}
	catch {
		req && req.resolve(res)
	}
	await avr_dequeue().catch(err => console.error("AVR Deque error",err))    		
}
async function create_zone_controls(err,count=0) {	
	if (!rheos_players.size && count <10){setTimeout(()=>{
		create_zone_controls(false,count++)},500);
		return 
	} else if (rheos_players.size){
		let failed_connections= []
		for await (let player of rheos_players){
			if ((!player[1].model.includes("HEOS") && player[1].type == "") || player[1].type == "AVR" ){	
				err = await connect_avr(player)
				if (err) {failed_connections.push[player]}
			}
		} 
		let i = 0
		while (failed_connections.length && i< 11){
			for await (let player of failed_connections){
				err = await connect_avr(player) 
				err && failed_connections.shift()
			}	
			i++
		}
		if (i == 11){console.error("⚠ FAILED TO SET AVR CONTROLS FOR ",failed_connections.map(p => p[1].name))}
		roon.save_config("players",[...rheos_players.values()].map((o) => {let {volume,output,zone,state,Z2,ZM,MV,SI,group, ...p} = o;return(p)}));
		return
	} else {
		console.error("⚠ UNABLE TO DISCOVER ANY HEOS PLAYERS - ABORTING")
		process.exit(0)
	}
}
async function connect_avr(player){
	try {	      
		player[1].Z2 = await control_avr(player[1].ip,"Z2?").catch()
		if (player[1].Z2){
			player[1].type = "AVR"
			player[1].ZM = await control_avr(player[1].ip,"ZM?").catch(err => console.error(player ? "NOT AN AVR : " + player[1].model : "ERROR GETTING MAIN STATE" + err))
			player[1].SI = await control_avr(player[1].ip,"SI?").catch(err => console.error(player ? "NOT AN AVR : " + player[1].model : "ERROR GETTING MAIN STATE" + err))
			avr_control = 2
			await create_avr_zones(player[1],1,false).catch(()=>{console.log("Create Zone 1 for ",player[1].name)})
			await create_avr_zones(player[1],2,false).catch(()=>{console.log("Create Zone 2 for ",player[1].name)})
			
			await update_zone_controls(player[1]).catch(()=>{console.log("Update Zone controls for ",player[1].name)})
			await create_avr_controls(player[1]).catch(()=>{console.log("Create AVR controls for ",player[1].name)})
            avr_control = 1
			
		} else { 
			player[1].type = "NON-AVR";
			return(true)
		}
	} catch {
		console.error("⚠ ERROR CREATING ZONE CONTROLS FOR",player[1].name)
		return(false)
	}
}
async function update_zone_controls(player){
	player.ZM = await control_avr(player.ip,"ZM?")
	player.SI = await control_avr(player.ip,"SI?")
	player.MV = await control_avr(player.ip,"MV?")
	player.Z2.length  || (player.Z2 = await control_avr(player.ip,"Z2?").catch(err => log && console.log(player ? "NO Z2: " + player.model : err)))
    return
}
async function create_avr_controls(player){
	const zones = [await get_output_by_name (player.name + " Zone 1"),await get_output_by_name (player.name + " Zone 2")]
	if (zones.filter(z => z?.source_controls[0]).length >1){
	let group = [(rheos_outputs.get(player.output))]
	svc_transport.change_volume(zones[0],"absolute",player.MV[0].slice(2))
	svc_transport.change_volume(zones[1],"absolute",player.Z2[2].slice(2))
	for (let index = 1; index < 3; index++) {
		if (avr_zone_controls[(Math.abs(player.pid)+index)]){
			return
		}
		let supports_standby,status
		switch(true){
		case (index == 1 && player.ZM.at(0)== "ZMON" && player.SI.at(0) == "SINET"):{
			group.push(zones[0])
			supports_standby = false
			status = 'selected'
		}
		break
		case (index == 2 && player.Z2.at(0)== "Z2ON" && player.Z2.at(1) == "Z2NET"):{
			group.push(zones[1])
			supports_standby = false
			status = 'selected'	
		}
		break
		default : 
			supports_standby = true
			status = 'deselected'	
		}
		let controller = {    
			state: {
				control_key: (Math.abs(player.pid)+index),
				display_name: zones[index-1].source_controls[0].display_name,
				supports_standby:  supports_standby,
				status:  status,
				output : zones[index-1].output_id,
				avr_output : player.output,
				pid : player.pid,
				ip : player.ip,
				index : index,
				player : player
			},  
			convenience_switch : async function (req) {
				req.send_complete("Success")
			},  
			standby:  async function (req) {		
				try{
					if (index === 1){
						avr_control = 2
						avr_zone_controls[this.state.control_key].update_state({status :"selected" })
						await create_avr_zones(this.state.player,1)						
						let s = await control_avr(this.state.ip,"ZM?").catch(()=>{}  )
						s.includes("ZMON") || 	await control_avr(this.state.ip,"ZMON").catch(()=>{} )
						s = await control_avr(this.state.ip,"SI?").catch(()=>{}  )
						s.includes("SINET") || await control_avr(this.state.ip,"SINET").catch(()=>{}  )
						avr_zone_controls[this.state.control_key].update_state({supports_standby: false})
						avr_control = 1
						req.send_complete("Success")	
					}
					if (index === 2){
						avr_control = 2
						avr_zone_controls[this.state.control_key].update_state({status :"selected" })
						await create_avr_zones(this.state.player,2)
						let s = await control_avr(this.state.ip,"Z2?").catch(()=>{}  )
						s.includes("Z2ON") ||  await control_avr(this.state.ip,"Z2ON").catch( ()=>{} )
						s.includes("Z2NET") || await control_avr(this.state.ip,"Z2NET").catch(()=>{}  )
						avr_zone_controls[this.state.control_key].update_state({supports_standby: false})
						avr_control = 1
						req.send_complete("Success")	
					}
				} catch {
					console.error("⚠ SOMETHING WENT WRONG STANDING BY",this.state.display_name)
					req.send_complete("Error")
				}
				avr_control = 2
				let group = svc_transport.zone_by_output_id(this.state.avr_output).outputs
				group.push(rheos_outputs.get(this.state.output))
                group = group.filter(o=>o)
				group?.length  && svc_transport.group_outputs(group)
				avr_control = 1
			}
		}
		player.group = group.map (o => o.output_id)
		avr_control = 2
		try{
			(avr_zone_controls[(Math.abs(player.pid)+index)]	= svc_source_control.new_device(controller))
			avr_zone_controls[(Math.abs(player.pid)+index)]["player"] = player
			avr_zone_controls[(Math.abs(player.pid)+index)]["avr_zone_control"] = controller.state
		} catch {
			console.error("⚠ UNABLE TO CREATE NEW ZONE " + index + " CONTROLLER")
		}
		avr_control = 1
	}
	let volume_control = {
		state: {
			display_name: player.name, 
			volume_type:  "incremental",
			player : player,
			op : group,
		},
		set_volume: async function (req, mode, value) {
			avr_control = 2
			await update_AVR_volume(this.state.player,value)
			req.send_complete("Success");
			avr_control = 1
		},
		set_mute: async function (req, action) {
			avr_control = 2
			if (action == 'toggle'){	
			let z = svc_transport.zone_by_output_id(player.output)
			z.outputs.forEach(async o => {
				if (o.source_controls[0].display_name.includes(" Zone 1")){
					svc_transport.mute(o,o.volume.is_muted ? "unmute" : "mute")
					try {
					 !o.volume.is_muted ? await control_avr( this.state.player.ip,"MUON") : await control_avr( this.state.player.ip,"MUOFF")	
					} catch {}	
				} 
				else if (o.source_controls[0].display_name.includes(" Zone 2")){
					svc_transport.mute(o,o.volume.is_muted ? "unmute" : "mute")
					try {!o.volume.is_muted ? await control_avr( this.state.player.ip,"Z2MUON") : await control_avr( this.state.player.ip,"Z2MUOFF")} catch {}
				} 
			})
			}
			req.send_complete("Success");
			avr_control = 1
		}
	}
	svc_volume_control.new_device(volume_control)
	group.length >1 && svc_transport.group_outputs(group)
	let display_name = "♫ Use Last Selected"
	let pid = my_settings["M"+player.pid]
	if (pid && pid.includes("LAST")){
		avr_control = 2
		try {
		let res = await control_avr(player.ip,"MS?")
		res = res.find(r=>r.includes("MS"))
		let index = sound_modes.indexOf(res)
		let mode  = index >-1 ? sound_modes.at(index) : "♫ "
		display_name = mode == "♫ " ? mode : "♫ " +to_title_case(mode.slice(2))
		} catch { display_name = "♫ Use Last Selected" }
		avr_control = 1
	} else {
		display_name = "♫ " + (pid ? to_title_case(pid.slice(2)) : "Use Last Selected")
	}
	let controller = {    
		state: {
			control_key: (Math.abs(player.pid.toString())+3).toString(),
			display_name: (player?.name + "\n♫ Sound Mode"),
			supports_standby: true,
			status:  'indeterminate',
			output :player.output,

			pid : player.pid,
			ip : player.ip		
		},  
		convenience_switch : async function (req) {
			try {	
				if (!this.state.display_name.toUpperCase().includes("LAST")){
					await control_avr(this.state.ip,"MS"+(this.state.display_name.slice(2).toUpperCase())).catch(() => {})		
				} 
				req.send_complete("Success")
			} catch {
				req.send_complete("Success")
			}
		},  
		standby:  async function (req ) {
			avr_control = 2
			await update_control(this.state.control_key,this.state.ip,this.state.display_name)
			req.send_complete("Success")
			avr_control = 1
		}
	}
	try{
		avr_zone_controls[(Math.abs(player.pid.toString())+3).toString()]	= svc_source_control.new_device(controller)
	} catch {
        console.log("⚠ UNABLE TO CREATE NEW SOUND CONTROLLER")
	}
	
	avr_zone_controls[(Math.abs(player.pid.toString())+3).toString()].update_state({display_name : display_name})//:
	update_avr_zones(player,zones )  
	}	 
return ("success")
}
async function update_avr_zones(player){
	let zone = svc_transport.zone_by_output_id(player.output)
	let outputs = (zone.outputs.map(o => o.output_id))
	if (sum_array(player.group) == sum_array(outputs)){return}
	const de_group = outputs.filter(o => {player.group.findIndex(g => g==o)==-1})
	de_group.length && svc_transport.ungroup_outputs(de_group)
	if (player.group.filter(o => outputs.findIndex(g => g==o)==-1).length){
		svc_transport.group_outputs(player.group)
	}
	return
}
async function update_control (control,ip,present){
	let present_mode_index = sound_modes.findIndex(sm => sm.includes(present.slice(2).toUpperCase()))
	let next = (present_mode_index<sound_modes.length-1 ? 	sound_modes.at(present_mode_index+1):sound_modes.at(0))
	let display_name = next.slice(2)
	avr_zone_controls[control.toString()].update_state({display_name : "♫ " + to_title_case(display_name), status : "indeterminate"}) 
}
async function create_avr_zones(player,i,kill = false){
	if(avr_control){
		let hex = ((Math.abs(player?.pid)+(i)).toString(16))
		let isOff = (i === 1 && (player.ZM.includes("ZMOFF") || !player.SI?.includes("SINET"))) || (i === 2 && (player.Z2.includes("Z2OFF" )|| !player.Z2.includes("Z2NET")))	
		if (rheos.processes[hex]?.pid && isOff){
			
			const zone = svc_transport.zone_by_output_id(player.output)
			const op = zone.outputs.map(o=> o).filter(o => o.source_controls[0].display_name.includes(i == 1? " Zone 1" : " Zone 2"))
			
			op.length && svc_transport.ungroup_outputs(op, (op)=>{console.log("UNGROUPING AVR ZONE 1",player.name,op)
			})
		} 
		if (player && kill == false){
			const mac = "bb:bb:"+ hex.replace(/..\B/g, '$&:').slice(-11)
			rheos.processes[hex] = spawn(squeezelite,["-M", i == 1?  player?.name + " Zone 1": player?.name + " Zone 2","-m", mac,"-o","-"])	
		} 
	}	
	return 
}
async function clear_avr_zones(){
	Object.values(avr_zone_controls).forEach(o => { 
     	if(o.avr_zone_control?.display_name &&  o.avr_zone_control?.display_name.includes(" Zone")){
	 		svc_transport.ungroup_outputs(o.player.group)
	 		kill_avr_output(o.avr_zone_control.display_name)
	 	}
	})
}
async function kill_avr_output(name){
	const p = Object.values(rheos.processes).find(p => p.spawnargs.includes(name))
	delete rheos.processes[p.pid]
	try {
		p.pid && process.kill(p.pid,'SIGKILL')	
	}
	catch {log && console.error(name,"ALREADY OFF")	}
}
async function update_outputs(outputs){
	return new Promise(async function (resolve) {
		for (let op of outputs) {	
		if (Array.isArray(op?.source_controls)){
			let old_op = rheos_outputs.get(op.output_id)
			const player = await get_player(op?.source_controls[0]?.display_name)
			if (op.source_controls[0].display_name.includes(" Zone")) {
				!old_op && rheos_outputs.set(op.output_id,op)
				op.type = "AVR"
				if (old_op?.display_name && old_op.display_name !== op.display_name ){
					let name = op.source_controls[0].display_name.split(" ")
					let player = await get_player(name[0].trim())
					let pid = Math.abs(player.pid)+ (name[1] == " Zone 1"? 1 : 2)
					avr_zone_controls[pid] && avr_zone_controls[pid].update_state({display_name : op.display_name})
				}
			}
			if  (player){	
				
				!old_op && rheos_outputs.set(op.output_id,op)
				player.output = op.output_id
				op.player = player
				op.volume?.value && await update_volume(op,player)
			} else	if (op.type == "AVR"){
				const name = op.source_controls[0].display_name
				let avr = await get_player(name.split(" ")[0].trim())
				avr && (avr.type = "AVR")
				if (name.includes(" Zone 1")) {
					try {(op.volume.value !== old_op?.volume.value) && avr?.ip && await control_avr(avr.ip,"MV"+op.volume.value)}catch {log && console.error("⚠ NO RESPONSE AVR Z1 VOL")}
					try {(op.volume.is_muted !== old_op?.volume.is_muted) && avr?.ip && await control_avr(avr.ip,"MU"+ (op.volume.is_muted ? "ON" : "OFF"))} catch {log && console.error("⚠ NO RESPONSE AVR Z1 MUTE")}
				}	
				if (name.includes(" Zone 2")) {
					try {(op.volume.value !== old_op?.volume.value) &&	avr?.ip && await control_avr(avr.ip,"Z2"+op.volume.value)}catch{log && console.error("⚠ NO RESPONSE AVR Z2 VOL")}
					try {(op.volume.is_muted !== old_op?.volume.is_muted) && avr?.ip && await control_avr(avr.ip,"Z2MU"+ (op.volume.is_muted ? "ON" : "OFF"))} catch {log && console.error("⚠ NO RESPONSE AVR Z2 MUTE")}
				}
			} else { 
				const group = [...fixed_groups.values()].find(fixed => fixed.sum_group == get_zone_group_value(svc_transport.zone_by_output_id(op.output_id)))
				if (group) {
					group?.gid && await update_group_volume(op,group,old_op?.volume.value !== op.volume.value,old_op?.volume.is_muted !== op.volume.is_muted)
				}
			}
			rheos_outputs.set(op.output_id,op)
		} else {
			rheos_outputs.delete(op)
		}
	}
	resolve()
	}).catch(err => console.error(err))
}
async function update_zones(zones){
	return new Promise(async function (resolve) {
		const avrs = [...rheos_players.values()].filter(p => p.type == "AVR").map(p => p.output)
		for (const z of zones) {	
			if (z.outputs ){
				const old_zone =  rheos_zones.get(z.zone_id)
				const fixed = ([...fixed_groups.values()].find(group => z.outputs[z.outputs.length -1].source_controls[0].display_name == group.display_name))
				if (z.outputs.filter(o => avrs.includes(o.output_id)).length){
					const player = [...rheos_players.values()].find(p => p.output == z.outputs[0].output_id)
					if (player.type == "AVR"){
						let standing_by =  (z.outputs.filter(o => (o.source_controls[0].status == "standby" && o.source_controls[0].display_name.includes(" Zone"))) )
						if (standing_by && standing_by.length){
							let pid = (Math.abs(player.pid.toString()))
							standing_by[0].source_controls[0].display_name.includes(" Zone 1" )&& (pid = (pid+1).toString())
							standing_by[0].source_controls[0].display_name.includes(" Zone 2" )&& (pid = (pid+2).toString())
							svc_transport.ungroup_outputs(standing_by)
							try{
								await create_avr_zones(player,standing_by[0].source_controls[0].display_name.includes(" Zone 1" )? 1 : 2,true)
								await control_avr(player.ip,standing_by[0].source_controls[0].display_name.includes(" Zone 1" )? "ZMOFF" : "Z2OFF").catch(()=> {})	
								avr_control === 2 && avr_zone_controls[pid] && avr_zone_controls[pid]?.update_state({supports_standby: true, status :"deselected" })
							} catch {
								log && console.error(player.ip,standing_by[0].display_name,"ALREADY OFF")
							}
						}
					}	
				}
				if (avr_control === 1 && z.outputs.length == 1 && z.outputs[0].source_controls[0].display_name.includes(" Zone" )){
					const control = Object.values(avr_zone_controls).find(o => o.avr_zone_control?.display_name ==z.outputs[0].source_controls[0].display_name )
					control && control.update_state({supports_standby: true, status :"deselected" })
					await kill_avr_output(z.outputs[0].source_controls[0].display_name)
				}
				if (fixed_control && fixed?.gid){
					const op = z.outputs[0]
					let zone_outputs = fixed.players.sort((a, b) => {let fa = a.role == "leader" ? 0 : 1; let fb = b.role == "leader" ? 0 : 1; return fa - fb} ).map(player => rheos_outputs.get(rheos_players.get(player.pid)?.output))
					zone_outputs.push(op)
					zone_outputs = zone_outputs.filter(Boolean)
					if ((z.state == "playing" && z.now_playing) && z.outputs.length == 1 ){
						svc_transport.transfer_zone( z,svc_transport.zone_by_output_id(zone_outputs[0].output_id))
						svc_transport.control(svc_transport.zone_by_output_id(zone_outputs[0].output_id),"play")
						group_pending.length = 0
						group_pending.push([z,zone_outputs[0].output_id])
					}
					if (group_pending.length && z.outputs.length == 1 && z.now_playing && z.now_playing?.one_line.line1 == group_pending[0][0]?.now_playing?.one_line.line1 ) {
						svc_transport.group_outputs(zone_outputs)
						svc_transport.control(svc_transport.zone_by_output_id(zone_outputs[0].output_id),"play")
						//svc_transport.control(z,"play")
					}
					if (group_pending.length && (z.outputs[0].output_id == zone_outputs[0].output_id )&& (z.outputs.length == zone_outputs.length ) ){
                        if (z?.is_play_allowed && z?.state !== "playing" && z?.state !== "loading") {
							svc_transport.control(z,"play")	
						} else if (z.state == "playing"){
							group_pending.shift()
						}	
					}
					if (!group_pending.length && fixed?.gid && (z.state == "paused" )  && z.outputs.length >1 && !group_pending.length){
						svc_transport.ungroup_outputs(z.outputs)
					}	   
				}	
				const group = (rheos_groups.get(get_pid(z.outputs[0]?.source_controls[0]?.display_name)))
				const old_roon_group = old_zone?.outputs?.map(output => get_pid(output?.source_controls[0]?.display_name))
				const new_roon_group = (z.outputs.map(output => get_pid(output.source_controls[0].display_name)))
				const heos_group = group?.players.map(player => player.pid);
				if (z.outputs.length > 1 && (sum_array(old_roon_group) !== sum_array(new_roon_group))  && (sum_array(new_roon_group) !== sum_array(heos_group))){
					await group_enqueue(new_roon_group)
				}	 
				rheos_zones.set(z.zone_id,z)
	        	fixed && z.outputs.length == 1 || z.state == 'paused' || z.state == 'stopped' || (old_zone?.now_playing?.one_line?.line1 == z?.now_playing?.one_line?.line1 ) ||  console.error(new Date().toLocaleString(), z.display_name, " ▶ ",z?.now_playing?.one_line?.line1)
			} else { 
				const zone =(rheos_zones.get(z))
				if (zone?.outputs.filter(op => get_pid(op.source_controls[0].display_name)).length >1){
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
	}).catch(err => console.error(err))
}
async function update_volume(op,player){
	let {is_muted,value} = op.volume
	let {mute,level} = player.volume 
	if ((mute !== (is_muted ? "on" : "off"))) {
		await heos_command("player", "set_mute", { pid: player?.pid, state: is_muted ? "on" : "off"}).catch(err => console.error(err))
	}
	if ((value || value === 0) && level !== value) {
		await heos_command("player", "set_volume", { pid: player?.pid, level: value }).catch(err => console.error(err))
	}
	(player.output = op.output_id) && (player.zone = op.zone_id)
}
async function update_AVR_volume(player,increment){
	increment == 1 && await heos_command("player", "volume_up", { pid: player?.pid, step: 1 }).catch(err => console.error(err))
	increment == -1 && await heos_command("player", "volume_down", { pid: player?.pid, step: 1 }).catch(err => console.error(err))
}
async function update_group_volume(op,group,vol,mute){
	    vol && await heos_command("group", "set_volume", { gid: group.gid, level: op.volume.value }).catch(err => console.error(err))
		mute && await heos_command("group", "set_mute", { gid: group.gid, state: op.volume.is_muted ? "on" : "off" }).catch(err => console.error(err))
}
async function heos_command(commandGroup, command, attributes = {}, timer = 5000) {
	if (!rheos_connection) {
		console.error("⚠ NO CONNECTION")
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
					"streambuf_size": [my_settings.streambuf_size],
					"output_size": [my_settings.output_size],
					"stream_length": [my_settings.stream_length],
					"codecs": ["aac,ogg,flc,alc,pcm,mp3"],
					"forced_mimetypes": ["audio/mpeg,audio/vnd.dlna.adts,audio/mp4,audio/x-ms-wma,application/ogg,audio/x-flac"],
					"mode": [("flc:0,r:-48000,s:16").toString().concat(my_settings.flow ? ",flow" : "")],
					"raw_audio_format": ["raw,wav,aif"],
					"sample_rate": ['48000'],
					"L24_format": ['2'],
					"roon_mode": ['1'],
					"seek_after_pause": [my_settings.seek_after_pause],
					"volume_on_play": [my_settings.volume_on_play],
					"flac_header": [my_settings.flac_header],
					"accept_nexturi": [my_settings.accept_nexturi],
					"next_delay": [my_settings.next_delay],
					"keep_alive": [my_settings.keep_alive],
					"send_metadata": [my_settings.send_metadata],
					"send_coverart": [my_settings.send_coverart],
					"flow":[my_settings.flow],
					"log_limit":[my_settings.log_limit]
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
				console.error("⚠ NO DEVICE ENTRIES")
				return
			}
			if (player && player[0]){
				let device = result?.squeeze2upnp?.device.find (d => d.name == rheos_players.get(Number(player[0]))?.name)
				set_player_resolution(device,player)
			}
			else {
				for await (const [index, device] of result?.squeeze2upnp?.device?.entries()) {
				let pid = get_pid(device.name[0])
				if ( pid)  {
					set_player_resolution(device,pid)	
				}
				else {
					delete result.squeeze2upnp.device[index]
				}
			}
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
			await fs.writeFile("./UPnP/Profiles/config.xml", devices.xml_template).catch(()=>{console.error("⚠ Failed to save config")})
			rheos.mode = false
			resolve()
		})
	})
}
async function set_player_resolution(device,pid){
    switch (true) {
	case  (pid[1] == "HR" || (!pid[1] && my_settings[(pid.toString())] == "HR")) :{
		device.enabled = ['1']
		device.mode = ("flc:0,r:192000,s:24").toString().concat(my_settings.flow ? ",flow" : "")
		device.sample_rate = ['192000']
	} 
	break
	case  (pid[1] == "THRU" || (!pid[1] && my_settings[(pid.toString())] == "THRU")) : {
		device.enabled = ['1']
		device.mode = "thru"
		device.sample_rate = ['192000']
	}
	break
	default :
		device.enabled = ['1']
		device.mode = ("flc:0,r:48000,s:16").toString().concat(my_settings.flow ? ",flow" : "")
		device.sample_rate = ['48000']
	}
	let subtemplate = { "squeeze2upnp": { "common": devices.template.squeeze2upnp.common, "device": [device] } }
	devices.xml_template = builder.buildObject(subtemplate)
	await fs.writeFile("./UPnP/Profiles/" + (device.name[0]) + ".xml", devices.xml_template).catch(()=>{console.error("⚠ Failed to create template for "+device.name[0])})
	create_player(pid[0] || pid)
}
async function start_listening() {
	update_status(false,false)
	await heos_command("system", "prettify_json_response", { enable: "on" }).catch(err => console.error("⚠ Failed to set responses"))
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
			console.error("⚠ UNABLE TO LOAD LINUX BINARIES - ABORTING",os)
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
          	console.error("⚠ UNABLE TO LOAD MAC BINARIES - ABORTING")
		  	process.exit(0)
		}
	}
	else {
		console.error("⚠ THIS OPERATING SYSTEM IS NOT SUPPORTED");
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
		group_dequeue().catch((err)=>{log && console.error("Deque error",err)})
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
		const res = await heos_command("group", "get_groups",3000).catch(err => console.error(err))
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
	}).catch(err => console.error(err))
}
async function connect_roon() {
	return new Promise(async function (resolve,reject) {
	const timer = setInterval(() => console.warn(" ⚠ Please ensure RHEOS is enabled in Settings -> Extensions"), 10000)
	const roon = new RoonApi({
		extension_id: "com.RHeos.beta",
		display_name: "Rheos",
		display_version: "0.7.3-0",
		publisher: "RHEOS",
		email: "rheos.control@gmail.com",
		website: "https:/github.com/LINVALE/RHEOS",
		log_level: "none",
		core_paired: async function (core) {
			log && console.log("ROON PAIRED")
			clearInterval(timer)
			
			svc_transport = core.services.RoonApiTransport
			svc_transport.subscribe_outputs(async function (cmd, data) {	
				switch (cmd){
					case "NetworkError" : 	
					    console.error('⚠',"NETWORK ERROR",cmd)
					break	
					case "Subscribed" : 
						for (const o of data.outputs) {
							if (Array.isArray(o?.source_controls)){
								let player = await get_player(o?.source_controls[0]?.display_name);
								player && (player.output = o.output_id)
								o.player = player
						    	rheos_outputs.set(o.output_id, o)
							}
						}
					break		
					case "Changed" : {
						
						Array.isArray(data.outputs_changed) && await update_outputs(data.outputs_changed,false)
						Array.isArray(data.outputs_added) && await update_outputs(data.outputs_added,true)
						if (Array.isArray(data.outputs_removed)) {
							await update_outputs(data.outputs_removed,false)
						}
					}
					break
					case "Error" : console.error('⚠',"SUBSCRIBED OUTPUT ERROR",cmd)
					break
					default: console.error('⚠',"SUBSCRIBED OUTPUT UNKNOWN ERROR",cmd,data)	
				}
			})
			svc_transport.subscribe_zones(async function (cmd, data) {
				switch(cmd){
					case "Subscribed" : 
						for (const z of data.zones) {
							await get_player(z.display_name) &&	rheos_zones.set(z.zone_id, z)  
						}
					case "Changed" : {	

						Array.isArray(data.zones_added) && await update_zones(data.zones_added);
						Array.isArray(data.zones_changed) && await update_zones(data.zones_changed);
						Array.isArray(data.zones_removed) && await update_zones(data.zones_removed);	
					}	
					break
					case "NetworkError" : console.error('⚠',"SUBSCRIBED ZONE ERROR",cmd)
					break
					default: console.error('⚠',"SUBSCRIBED ZONE UNKNOWN ERROR",cmd,data)
				}
			})
		},
		core_unpaired: async function (core) {
			core = undefined
		}
	})
	if (roon){
		resolve (roon)
	}else{
		console.error("⚠ NO ROON API FOUND PLEASE CHECK YOUR ROON SERVER IS SWITCHED ON AND ACCESSIBLE AND TRY AGAIN");
		reject
	}
})
}
async function update_status(message = "",warning = false){
	let RheosStatus = rheos_players.size + " HEOS Players on " + system_info[2] +" "+ system_info [3]+" "+ system_info [4] + ' at ' + system_info[0] + '  for ' + get_elapsed_time(start_time) + '\n'
    if (rheos.mode){
		RheosStatus = RheosStatus + "_".repeat(150) + " \n \n " + (rheos.discovery > 0 ? ("⚠      UPnP CONNECTING       " + ("▓".repeat((rheos.discovery < 39 ? rheos.discovery : 50))+"░".repeat(30-(rheos.discovery <30 ? rheos.discovery : 50))))
		: ("DISCOVERED " + rheos_players.size + " HEOS PLAYERS")) + "\n \n"
		for (let player of rheos_players.values()) {
		const { name, ip, model } = player
		let quality = (my_settings[player.name])
		RheosStatus = RheosStatus + (rheos.discovery ? "◐◓◑◒".slice(rheos.discovery % 4, (rheos.discovery % 4) + 1) + " " : (quality === "HR")  ?"◉  " :"◎  " ) + name?.toUpperCase() + " \t " + model + "\t" + ip + "\n"
		}	
	}
	for (let zone of [...rheos_zones.values()].filter(zone => (!zone.outputs[0]?.source_controls[0].display_name.includes("🔗") && zone.state ==="playing") )) {	
		RheosStatus = RheosStatus + (zone.outputs.length == 1 ?"🎵 ":"🎶  ") + (zone.fixed?.zone?.output || zone.display_name) + "\t ▶ \t" + zone.now_playing?.one_line?.line1 + "\n"
	}
	message && (RheosStatus = RheosStatus + "\n \n" + message)
	svc_status.set_status(RheosStatus,warning)
}
async function get_player(player_name) {
	let player = [...rheos_players.values()].find((player) => player?.name?.trim().toLowerCase() === player_name?.trim().toLowerCase())
	return player
}
async function get_all_groups(){
	all_groups.clear()
	for (const group of rheos_groups){
		all_groups.set(get_heos_group_value(group[1]),group[1])
	}
	for (const group of fixed_groups){
		all_groups.set(get_heos_group_value(group[1]),group[1])
	}
	return all_groups
}
function get_output_by_name(name){
	return ([...rheos_outputs.values()].find (o => o.source_controls[0].display_name === (name))
	)
}
function makelayout(my_settings) {
	const players = [...rheos_players.values()],
	ips = players.map(player => new Object({ "title": player.model + ' (' + player.name + ') ' + ' : ' + player.ip, "value": player.ip }))
	ips.push({ title: "No Default Connection", value: undefined })
	let l = {
		values: my_settings,
		layout: [],
		has_error: false
	}
	l.layout.push(
		ips.length > 1
			?
			{ type: "dropdown", title: "Default Heos Connection", values: ips, setting: "default_player_ip" }
			:
			{ type: "string", title: "Default Heos Player IP Address", maxlength: 15, setting: "default_player_ip" }
	)
	l.layout.push(
		{ type: "string", title: "Roon Extension Host IP Address", maxlength: 15, setting: "host_ip" }
	)
	l.layout.push(
		{ title: "Enable AVR Zone Control ", type: "dropdown", setting: 'avr_control', values : [{title: "ON", value : true},{title : "OFF", value :false}]}
		
	)
	l.layout.push(
		{ title: "Enable Fixed HEOS Groups ", type: "dropdown", setting: 'fixed_control', values : [{title: "ON", value : true},{title : "OFF", value :false}]}
		
	)
	if (players.length) {
		let _players_status = { type: "group", title: "PLAYERS", subtitle: "Set player resolution", collapsable: true, items: [] }
		players.forEach((player) => {
			if (player) {
				_players_status.items.push({
					title: ('◉ ') + player.name.toUpperCase(),
					type: "dropdown",
					values: [{ title: "Hi-Resolution", value: "HR" }, { title: "CD Quality", value: "CD" },{ title: "Pass Through", value: "THRU" }],
					setting: player.pid.toString()
				})
			}
		})
		l.layout.push(_players_status)
	}
	if (my_settings.avr_control){
		let _avrs = { type: "group", title: "RECEIVERS", subtitle: "Set default mode for Denon/Marantz AVRs", collapsable: true, items: [] };
		for (let player of rheos_players) {
			if (player[1].type == "AVR") {
				let values = []
				sound_modes.forEach(mode => values.push({value: mode, title: to_title_case(mode.slice(2)) }))
				_avrs.items.push({
					title: player[1].name,
					type: "dropdown",
					values: values, 
					setting: "M"+player[0]
				})
			}
		}
		l.layout.push(_avrs)
	}
	if (my_settings.fixed_control){
		let _fixed_groups = { type: "group", title: "GROUPS", subtitle: "Create fixed groups of players", collapsable: true, items: [] };
		_fixed_groups.items.push(
			{ title: "Max Safe Fixed_Group Volume", type: "integer", setting: 'max_safe_vol', min: 0, max: 100 }	
		)
		for (let group of all_groups.entries()) {
			if (group) {
				let name = group[1].players.map(player=>player.name).toString()
				let values = []
				values.push({title: "HI RES FIXED GROUP", value: 192000})	
				values.push({title: "CD RES FIXED GROUP", value: 48000})	
				values.push({title: "DELETE GROUP", value: "DELETE"})
				_fixed_groups.items.push({
					title: name,
					type: "dropdown",
					values: values, 
					setting: group[1].sum_group
				})
			}
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
		{ title: "● Send Metadata", type: "dropdown", setting: 'send_metadata', values: [{ title: "On", value: 1 }, { title: 'Off', value: 0 }] },
		{ title: "● Send Cover Art", type: "dropdown", setting: 'send_coverart', values: [{ title: "On", value: 1 }, { title: 'Off', value: 0 }] },
		{ title: "● Flow Mode", type: "dropdown", setting: 'flow', values: [{ title: "On", value: 1 }, { title: 'Off', value: 0 }] },
		{ title: "● Log File Size Limit (MB) -1 for unlimited", type: "integer", setting: 'log_limit', min: -1, max: 10 }
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
	return( sum_array(zone.outputs.map(o => get_pid(o.source_controls[0].display_name)))) 
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
		process.exit(0);	
    };

    process.on('SIGTERM', handle);
    process.on('SIGINT', handle);
}
function to_title_case(str) {
	return str.replace(
	  /\w\S*/g,
	  function(txt) {
		return txt.charAt(0).toUpperCase() + txt.substr(1).toLowerCase();
	  }
	);
}
 
