"use-strict";
import HeosApi from "heos-api"
import RoonApi from "node-roon-api"
import RoonApiSettings from "node-roon-api-settings"
import RoonApiStatus from "node-roon-api-status"
import RoonApiVolumeControl from "node-roon-api-volume-control" 
import RoonApiSourceControl from "node-roon-api-source-control"
import RoonApiTransport from "node-roon-api-transport"
import child from "node:child_process"
import util, { isArray } from "node:util"
import fs from "node:fs/promises"
import os from "node:os"
import xml2js, { parseStringPromise } from "xml2js"
import ip from "ip"
let roon,svc_status,my_settings,svc_source_control,svc_transport,svc_volume_control,rheos_connection = {}
let rheos_processes = {}
let mode = false
let timer
let buffer_processing = false
let listening = false
const group_buffer = []
const execFileSync = util.promisify(child.execFile);
const spawn = (child.spawn)
const rheos_players = new Map ()
const rheos_outputs = new Map ()
const rheos_zones = new Map ()
const rheos_groups = new Map ()
const builder = new xml2js.Builder({async : true})
await start_roon()
await start_up()
await set_permissions()
await discover_devices().catch(err=> console.error(err))
await build_devices().catch(err=> console.error(err))
await create_players().catch(err=> console.error(err))
await add_listeners().catch(err=> console.error(err))
await start_listening().catch(err=> console.error(err))
await get_heos_groups()

console.log(ip.address(),os.type(),os.hostname(),os.platform(),os.arch())
console.table([...rheos_players.values()],["name","pid","model","ip","status"])
async function monitor(){
	setInterval(async ()=>{
		if (rheos_outputs.size !== rheos_players.size){
			update_status()			
		} 
		heos_command("system","heart_beat",{}).catch(err=> console.error("HEARTBEAT ERROR",err))
		svc_transport.get_outputs((err,ops)=>{
			for (const op of ops.outputs){
				if(!rheos_outputs.has(op.display_name) ) {
					const found = [...rheos_players.values()].find(x => x.name == op.display_name)
					if (found) {
						rheos_outputs.set(op.display_name,op)
						found.output = op.output_id
					}
				}
			}
			update_status()
		})
	},5000)
	return
}
async function add_listeners() {	
	const listeners = await rheos_connection[0]
	listening = true
    listeners.write("system", "register_for_change_events", { enable: "on" })
	listeners
		.on({ commandGroup: "system", command: "heart_beat" }, async (res) => {
			res?.heos?.result == "success" || console.error("HEARTBEAT failed",res)	
		})
		.onClose(async (hadError) => {
			console.error("Listeners closed", hadError)
			await start_up()
			await set_permissions()
			await discover_devices().catch(err=> {console.log(err)})
			await build_devices().catch(err=> console.error(err))
			await create_players().catch(err=> console.error(err))
			await add_listeners().catch(err=> console.error(err))
			await start_listening().catch(err=> console.error(err))
		})
		.onError((error) => console.error(error))
		.on({ commandGroup: "event", command: "groups_changed" }, async () => {	
			let res =	await heos_command("group","get_groups").catch(err=> console.error("GROUP ERROR",err))
			if (! res.payload && res.result == 'success') {rheos_groups.clear()}
			for await (const group of res.payload){
				rheos_groups.set(group.gid,group)
			}
            if (res.payload.length < rheos_groups.size){
               let cleared_zones = ([...rheos_zones.values()].filter(zone => zone.group.length >1 && !res.payload.map(group => group.gid).includes(zone.group[0].pid)))
			   for (const zone of cleared_zones){
			    svc_transport.ungroup_outputs(zone.outputs.map(output => output.output_id))
			   }
			}
			for (let group of res.payload){
				let players = group.players.sort(
					(a,b) => {
							let fa = a.role=="leader" ? 0 : 1
							let fb = b.network == "leader" ? 0 : 1
							return fa - fb}
				)
				const zone_id = ([...rheos_zones.values()].flatMap(zone => zone.outputs).find(output => output?.display_name == (rheos_players.get(group.gid).name))?.zone_id)
				if (zone_id){
				const zone = rheos_zones.get(zone_id)
					if (zone?.group && sum_array(zone?.group.map(o => o.pid)) !== sum_array(players.map(player => player.pid))){
						if (zone?.group?.length > players.length){
							let ungroup = zone?.group.filter(o => { return !players.map(player => player.pid).includes(o.pid)}).map(player => rheos_outputs.get(player.name))
							ungroup.length && svc_transport.ungroup_outputs(ungroup.filter(x=> x))
						} else if (zone?.group.length && zone?.group?.length < players.length){
							let zone_group = players.map(player => rheos_outputs.get(player.name))
							players.shift()
							for (const player of players){
                             rheos_groups.delete(player.pid)
							}
							zone_group.length>1 && svc_transport.group_outputs(zone_group)
						}
					}
				}
			}
		})	 
		.on({ commandGroup: "event", command: "players_changed" }, async (res) => {
			const players = await heos_command("player", "get_players").catch(err=> console.error(err))
			const player_names = players.payload.map(player => player.name)
			const new_players = players.payload.filter(player => !rheos_outputs.has(player.name))
			const deleted_players = [...rheos_players.values()].filter(player=> !player_names.includes(player.name))
			for (let player of new_players)	{
				rheos_players.set (player.pid, player)
				await create_players()
				my_settings[player.name]="Off"
			}
			for (let player of deleted_players){
                rheos_outputs.delete(player.name)
				rheos_players.delete(player.pid)
				delete my_settings[player.name]
			}
		})
		.on({ commandGroup: "event", command: "player_playback_error" }, async (res) => {
			console.error(res)
			const {heos:{message:{parsed: { error, pid }}}} = res
			let zone = rheos_zones.get(rheos_outputs.get(rheos_players.get(pid)?.name).zone_id)
			if (error.includes ("Unable to play")){
				if(zone?.is_play_allowed){
					svc_transport.control(zone,'play')	
				}	        
			} else if(error.includes ("Unsupported format")){
				svc_transport.seek(zone,'absolute',0)
				svc_transport.control(zone,'play')
			}	
		})
		.on({ commandGroup: "event", command: "player_volume_changed" }, async (res) => {
			const {heos:{message:{parsed: { mute,level, pid }}}} = res, player = rheos_players.get(pid)			
			if (player?.volume && level !== player.volume?.level) {
				 player.volume.level = level
				 svc_transport.change_volume(rheos_outputs.get(player.name), 'absolute',level,()=>{player.volume.level = level})
			}
			if (player?.volume && mute !== player.volume?.mute) {player.volume.mute = mute; svc_transport.mute(rheos_outputs.get(player.name), mute == "on"? 'mute' : 'unmute')}
		})	
}
async function discover_devices() {
	return new Promise(async function(resolve,reject){
		const players = ([...rheos_players.values()].map(player => player.name))
		try {
			const data = await fs.readFile('./UPnP/Profiles/config.xml', 'utf8').catch(new Error  ("file needs to be created"))	
			const slim_devices = await parseStringPromise(data)
			if (data && slim_devices.squeeze2upnp.device.map(d => d.friendly_name[0]).toString().length == players.toString().length){
				resolve (data)
			} else {
				throw "players have changed"
			}	
		}
		catch {
			let counter = 1
			let message = setInterval(function(){counter ++; svc_status.set_status("DISCOVERING NEW HEOS DEVICES PLEASE WAIT"+(".".repeat(counter)) , false)},1000)
			await  create_root_xml().catch(console.log("CREATING NEW XML ROOT"))
			const data = await fs.readFile('./UPnP/Profiles/config.xml', 'utf8').catch(new Error  ("file needs to be created"))
			clearInterval(message)
			data && resolve(data) || reject()
		}
	})
}
async function create_root_xml(){
	return new Promise(function (resolve){
		execFileSync(choose_binary(), ['-i', './UPnP/Profiles/config.xml','-b', ip.address()],()=> {resolve()});
	}) 
}
async function start_up(){	
	const heos = [HeosApi.discoverAndConnect({timeout:1000,port:1255, address:ip.address()}),HeosApi.discoverAndConnect({timeout:1000,port:1267, address:ip.address()})]
        try {
            rheos_connection = await Promise.all(heos)
			rheos_connection[1].socket.setMaxListeners(0)
				let players = await get_players(rheos_connection[0])	
				for (let player of players)	{
					player.status = my_settings[player.name]
					rheos_players.set (player.pid, player)	
				}
				players
				.sort((a,b) => {
					let fa = a.network =="wired" ? 0 : 1
					let fb = b.network == "wired" ? 0 : 1
					return fa - fb
				})			
        }
        catch (err) {
			throw "Unable to connect discover any Heos Players"
		}	  
    return([...rheos_players.values()] || [])
}
async function get_players(){ 
        return new Promise(function (resolve,reject){
            rheos_connection[0].write("player","get_players",{})
            .once({commandGroup:'player', command : 'get_players'},(player)=>{
                if (player?.payload?.length){ 
                    resolve (player?.payload)
                } else if (player.heos.result == "fail") {
                    reject (player)
                } else if(player.heos.message.unparsed == "command under process"){
                    rheos_connection[0].once({commandGroup:'player', command : 'get_players'},
                    (res) => {
                        resolve (res.payload)
                    })
                } else {
                	reject (player)
                }
            })
        })
}
async function create_players(){
	if (mode){	
		if (rheos_processes.main && !rheos_processes.main.killed){let x = rheos_processes.main.kill(2)}
	} else {
		if (!rheos_processes.main || rheos_processes.main.killed){
			(fs.truncate('./UPnP/common.log',0).catch(()=>{}))
			rheos_processes.main = spawn(choose_binary(), ['-b',ip.address(),'-Z','-M','RHEOS','-f','./UPnP/common.log','-x','./UPnP/Profiles/config.xml'],{stdio:'ignore'});
		}
	} 
	for (let player of rheos_players.values()){
		if (mode){
			if (!rheos_processes[player.pid] || rheos_processes[player.pid].killed){
				await (fs.truncate('./UPnP/Profiles/'+player.name.replace(/\s/g,"")+'.log',0).catch(()=>{}))
				rheos_processes[player.pid] = spawn(choose_binary(), ['-b',ip.address(),'-Z','-M','RHEOS: select Enable and then '+'\r\n'+ 'Edit "' +player.name+ '" and Save Extension Settings ',
				'-x','./UPnP/Profiles/'+player.name.replace(/\s/g,"")+'.xml','-f','./UPnP/Profiles/'+player.name.replace(/\s/g,"")+'.log'],{stdio:'ignore'})
			}
		}else{
			if (rheos_processes[player.pid] && !rheos_processes[player.pid].killed){rheos_processes[player.pid].kill(2)}
		}
	}
	
}
async function start_roon() {
    roon =  connect_roon()
    svc_status = new RoonApiStatus(roon),
    svc_source_control = new RoonApiSourceControl(roon),
    svc_volume_control = new RoonApiVolumeControl(roon),
    svc_transport = new RoonApiTransport(roon),
    my_settings = roon.load_config("settings") || {}
	my_settings.host_ip ||(my_settings.host_ip = ip.address())
    my_settings.streambuf_size || (my_settings.streambuf_size = 524288)
	my_settings.output_size || (my_settings.output_size = 8388608)
	my_settings.stream_length || (my_settings.stream_length = -1)
	my_settings.seek_after_pause || (my_settings.seek_after_pause = 1)
	my_settings.volume_on_play || (my_settings.volume_on_play = -1)
	my_settings.volume_feedback || (my_settings.volume_feedback = 0)
	my_settings.accept_nexturi|| (my_settings.accept_nexturi = 0)
	my_settings.flac_header || (my_settings.flac_header = 2)
	my_settings.keep_alive || (my_settings.keep_alive = -1)
	my_settings.next_delay || (my_settings.next_delay = 30)
	my_settings.send_coverart || (my_settings.send_coverart = 1)
	my_settings.send_metadata || (my_settings.send_metadata = 1)
    const svc_settings = new RoonApiSettings(roon, {
        get_settings: async function (cb) {
			mode = true
			await update_status()
			await create_players()
            cb(makelayout(my_settings))
        },
        save_settings: async function (req, isdryrun, settings) {
			mode = false
			create_players()
			
            let l = makelayout(settings.values)
			if (l.values.default_player_ip && !l.has_error){
            	await HeosApi.connect(l.values.default_player_ip,1000).catch(err => (l.has_error = err))
			}	
            req.send_complete(l.has_error ? "NotValid" : "Success", { settings: l })
            if (!isdryrun && !l.has_error) {
				mode = false
				update_status()
                my_settings = l.values
                svc_settings.update_settings(l)
                roon.save_config("settings", my_settings)
				await build_devices()	
            }
        }
    })
    roon.init_services({
        required_services: [RoonApiTransport],provided_services: [svc_status, svc_source_control, svc_volume_control, svc_settings]
    })
    roon.logging = "EVENT"
    roon.start_discovery()
    return roon
}
function connect_roon(){
    const roon = new RoonApi({
		extension_id: "com.Linvale115.test",
		display_name: "RHeos",
		display_version: "0.3.1-5",
		publisher: "RHEOS",
		email: "Linvale115@gmail.com",
		website: "https://github.com/LINVALE/RHEOS",
		log_level: "none",
		core_paired: async function (core) {
			clearInterval(timer)
			await monitor()
			svc_transport = core.services.RoonApiTransport
			svc_transport.subscribe_outputs(async function (cmd, data) {     
				if (cmd == "Subscribed") {
					data.outputs?.forEach((op) => {
						const found = [...rheos_players.values()].find(x => x.name == op.display_name)
						if (found) {
							
							rheos_outputs.set(op.display_name,op)
							found.output = op.output_id
						}	
					})	
				}
				if (cmd == "Changed"&& data.outputs_changed) {		
					for (let op of data.outputs_changed){  
						let old_op = rheos_outputs.get(op.output_id)	
						let player = rheos_players.get(heos_get_player_pid_by_name(op.display_name))
						if (player && op.volume){
							if (player?.volume){
								if (op?.volume?.is_muted !== old_op?.volume?.is_muted){	
									await heos_command("player", "set_mute", {pid : heos_get_player_pid_by_name(op?.display_name) , state :op?.volume?.is_muted ? "on" : "off"}).catch(err=> console.error(err))
								}
								if (op?.volume?.value !== old_op?.volume?.value ){
									if (player.volume?.level !== op.volume.value) {
										process.nextTick(()=>{player.volume.level = op.volume.value})
										await heos_command("player", "set_volume", {pid : heos_get_player_pid_by_name(op?.display_name) , level :op?.volume?.value}).catch(err=> console.error(err))
									}	
								}
							} else {
								player.volume = {level :op.volume.value, mute : op.volume.is_muted ? "on": "off"}
							}
						}
					}
				}  
				if (cmd == "Changed"&& data.outputs_added) {
					data.outputs_added?.forEach((op) => {
						const found = [...rheos_players.values()].find(x => x.name == op.display_name)
						if (found){
							rheos_outputs.set(op.display_name,op)
							found.output = op.output_id
						}
					})
				}
				if (cmd == "Changed"&& data.outputs_removed) {
					data.outputs_removed?.forEach((op) => {
						let id = [...rheos_outputs.values()].find(op =>{op.output_id === op})
                        if (id){
							const found = [...rheos_players.values()].find(x => x.name == id.display_name)
							if (found){
								rheos_outputs.delete(id.display_name)
								found.output = undefined
							}
						}
					})
				}
				if (cmd == "Network Error") {
					console.error("NETWORK ERROR", cmd)
					start_roon()
				} 
			})
			svc_transport.subscribe_zones(async function (cmd, data) {
				if (cmd == "Subscribed") {
					if (data.zones) {
						for (const e of data.zones){
							rheos_zones.set(e.zone_id,e)
							const zone = rheos_zones.get(e.zone_id)
							const group = e.outputs.map(o => {return {output_id:o?.output_id,name: o?.display_name,pid: heos_get_player_pid_by_name(o?.display_name)}})
							if (group) {zone.group = group} else {zone.group = []}
						}
					}				
					return roon
				}
				if (cmd === "Changed") {
					if (data.zones_seek_changed){data.zones_seek_changed.forEach(z => {	
							if (z.seek_position === null || z.seek_position === 0){
								let zone = rheos_zones.get(z.zone_id)
								setTimeout((zone) => {zone && (rheos_zones.get(zone.zone_id)?.state === 'playing' || svc_transport.control(zone,'play'))},3000,zone)
							}
					})}
					if (data.zones_removed){
					
						for await (const e of data.zones_removed){
							const zone = rheos_zones.get(e)
							const group = rheos_groups.get(zone?.group[0].pid)
							if (group?.length >1){
								let pid = zone.group[0].pid
								rheos_groups.delete(pid)
								group_buffer.push([pid])
								buffer_processing || group_command_buffer()	
							}
							rheos_zones.delete(e)
						}
					}					
					if (data.zones_added){
						for  await (const e of data.zones_added){
							rheos_zones.set(e.zone_id,e)
							const zone = rheos_zones.get(e.zone_id)
							const group = e.outputs?.map(o => {return {output_id:o.output_id,name: o.display_name,pid: heos_get_player_pid_by_name(o.display_name)}})
							if (group) {
								zone.group = group
							} else {
								zone.group = []
							}
							if (zone.group.length >1) {

								let heos_group = (rheos_groups.get(zone.group[0].pid)?.players.map(player => player.pid))
								let roon_group = (zone.group.map(player => player.pid))
								if (sum_array(roon_group) !== sum_array(heos_group)){
										group_buffer.push(zone.group.map(player => player.pid))
								    	buffer_processing || await group_command_buffer()	
								}	
							} else if (zone.group?.length == 1){
								if(rheos_groups.get(zone.group[0].pid)){
									group_buffer.push([zone.group[0].pid])
									buffer_processing || await group_command_buffer()	
								}
							}
						}
					}
					if (data.zones_changed ){	
						for await (const e of data.zones_changed){
							const old_zone = (rheos_zones.get(e.zone_id) || {})
							if (!old_zone.group){old_zone.group = []}
						
							rheos_zones.set(e.zone_id,e) 
							const zone = rheos_zones.get(e.zone_id)
								
							const group = e.outputs?.map(o => {return {output_id:o.output_id,name: o.display_name,pid: heos_get_player_pid_by_name(o.display_name)}})
							if (group) {zone.group = group} else {zone.group = []}				
							if (zone.group.length >1 && (String(zone.group.map(o => o.pid)) !== String(old_zone.group.map(o => o.pid)))){
								group_buffer.push(zone.group.map(o => o.pid))
								buffer_processing || await group_command_buffer()	
							}
						}
					}
				} 
			})
		},
		core_unpaired: function (core) {
			core = undefined
		}
    })
    timer = setInterval(() => console.warn(" ⚠ Please ensure RHEOS is enabled in Settings -> Extensions"), 10000)	
    return  (roon)
}
async function heos_command(commandGroup, command, attributes = {}, timer = 3000) {
	typeof attributes === "object" || ((timer = attributes), (attributes = {}))
	return new Promise(function (resolve, reject) {
		rheos_connection[0].write(commandGroup, command, attributes)
		rheos_connection[0].once({ commandGroup: commandGroup, command: command, attributes }, (res) => {
			res.parsed = res.heos.message.parsed
			res.result = res.heos.result
			if (res.heos.result === "success") {
				if (res.heos.message.unparsed.includes("under process")){	
					rheos_connection[0].once({ commandGroup: commandGroup, command: command, attributes }, (res) => {
						if (res.heos.result === "success") {								
							resolve(res)
						} else {
							reject(res)
						}
					})
				} else {
					resolve(res)
				} 	
			} else {
				if (res.heos.message.unparsed.includes("not executed")){
					resolve(res)
				} 
			reject(res)
			}
		})
	})
}
async function build_devices(){
	return new Promise(async function(resolve){
	let template,xml_template={}
	template ={
		"squeeze2upnp": {
			"common": [
				{	"enabled": ['0'],
					"streambuf_size": [my_settings.streambuf_size],
					"output_size": [my_settings.output_size],
					"stream_length": [my_settings.stream_length],
					"codecs": ["aac,ogg,flc,alc,pcm,mp3"],
					"forced_mimetypes": ["audio/mpeg,audio/vnd.dlna.adts,audio/mp4,audio/x-ms-wma,application/ogg,audio/x-flac"	],
					"mode": [{"_": "flc:","q": ['0']}],
					"raw_audio_format": ["raw,wav,aif"],
					"sample_rate": ['48000'],
					"L24_format": ['2'],
					"roon_mode": ['1'],
					"seek_after_pause": [my_settings.seek_after_pause],
					"volume_on_play": [my_settings.volume_on_play],
					"flac_header":[my_settings.flac_header],
					"accept_nexturi": [my_settings.accept_nexturi],
					"next_delay": [my_settings.next_delay],
					"keep_alive":[my_settings.keep_alive],
					"send_metadata":[my_settings.send_metadata],
					"send_coverart":[my_settings.send_coverart],
				}	
			],
			"device": []
		}
	}
	let data = await (fs.readFile('./UPnP/Profiles/config.xml', 'utf8'))
	xml2js.parseString(data, async (err,result)=>{
		if(err) {throw err} 
		for await (const [index,device] of result.squeeze2upnp.device.entries()){
			const pid = heos_get_player_pid_by_name(device.name[0])
			if(pid){
				if(my_settings[(device.name[0])]=="HR"){
					device.enabled = ['1']
					device.sample_rate = ['192000'] 
					device.L24_format = ['1']
				} else if (my_settings[(device.name[0])]=="CD"){
					device.enabled = ['1']
					device.sample_rate = ['48000'] 
					device.L24_format = ['2']
				}
					let subtemplate = {	"squeeze2upnp": {"common": [{"enabled": ['0']}],"device": [device]}}
					xml_template = builder.buildObject(subtemplate)
					await fs.writeFile("./UPnP/Profiles/"+(device.name[0].replace(/\s/g,""))+".xml",xml_template)
				}
			 else {
				delete result.squeeze2upnp.device[index]
			}				
		}       
		result.squeeze2upnp.common[0]=template.squeeze2upnp.common[0]
		result.squeeze2upnp.common[0].enabled=['0']
		result.squeeze2upnp.device = result.squeeze2upnp.device
		xml_template = builder.buildObject(result)
		await fs.writeFile("./UPnP/Profiles/config.xml",xml_template)
		resolve()
		})
	})
}
async function start_listening() {
	update_status()
	heos_command("system", "prettify_json_response", { enable: "on" }).catch(err=> console.error(err))
}
function update_status() {
	let RheosStatus = "_".repeat(120) + "\n \n"
	RheosStatus = RheosStatus + (mode ? "⚠ IN CONFIGURATION MODE - PLEASE SAVE EXTENSION SETTINGS TO ENABLE PLAY MODE"+"\n" : " 🔛 IN PLAY MODE - SELECT SETTINGS TO CONFIGURE" +"\n")
	RheosStatus = RheosStatus + "_".repeat(120) + " \n \n DISCOVERED " + rheos_players.size + " HEOS PLAYERS" + "\n \n"
	for (let player of rheos_players.values()) {
		const { name,ip,model} = player
		RheosStatus = RheosStatus + (rheos_outputs.get(name)? "◉  ":"◎  ") +name?.toUpperCase()   + " \t "+ model + "\t" + ip + "\n"
	}
	RheosStatus = RheosStatus + "_".repeat(120)+"\n \n"
	for (let zone of [...rheos_zones.values()].filter(zone => zone.state == "playing")){
		RheosStatus = RheosStatus +"🎶  "+zone.display_name +"\t ▶ \t"+ zone.now_playing.one_line.line1+"\n"
	}
	RheosStatus = RheosStatus + "_".repeat(120)
	svc_status.set_status(RheosStatus, mode)
}
function makelayout(my_settings) {
	const players = [...rheos_players.values()], 
	ips = players.map(player => new Object({"title":player.model+ ' (' +player.name +') '  +' : '+player.ip,"value":player.ip}))
    ips.push({title:"No Default Connection",value: undefined})
	let l = {
		values: my_settings,
		layout: [],
		has_error: false
	}
	l.layout.push(
		ips.length>1
		?
		{type: "dropdown",title: "Default Heos Connection",values: ips,setting: "default_player_ip"	}
		:	
		{type: "string",title: "Default Heos Player IP Address",	maxlength: 15,setting: "default_player_ip"}
	)
	l.layout.push(
		{type: "string",title: "Roon Extension Host IP Address",maxlength: 15,setting: "host_ip"}
	)
	if (players.length) {		
		let _players_status = {type : "group",	title : "PLAYER STATUS",subtitle:" ",	collapsable: false,	items : []}
		players.forEach((player) => {
			if (player){
				_players_status.items.push({
					title: (rheos_outputs.get(player.name)? '◉ ' : '◎ ')+player.name.toUpperCase(),
					type : "dropdown",
					values : [{title : "Hi-Resolution",value :"HR"},{title :"CD Quality",value:"CD"}],
					setting : player.name
				})	
			}
		})							
		l.layout.push(_players_status)
	}
	l.layout.push ({type : "group",	title : "RHEOS UPnP SETTINGS",	collapsable: false,	items : [
		{title:"● Buffer Size",type:"dropdown", setting:'streambuf_size', values:[{title:"Small", value:524288},{title:"Medium", value:524288*2},{title : 'Large',value:524288*3}]},
		{title:"● Output Size",type:"dropdown", setting:'output_size', values:[{title:'Small',value:4194304},{title : 'Medium',value:4194304*2},{title:'Large',value:4194304*3}]},
		{title:"● Stream Length",type:"dropdown", setting:'stream_length', values:[{title: "no length", value:-1},{title:'chunked',value:-3}]},
		{title:"● Seek After Pause",type:"dropdown", setting:'seek_after_pause', values:[{title: "On", value:1},{title:'Off',value:0}]},
		{title:"● Volume On Play",type:"dropdown", setting:'volume_on_play', values:[{title: "On Start Up", value:0},{title:'On Play',value:1},{title:"Never",value:-1}]},
		{title:"● Volume Feedback",type:"dropdown", setting:'volume_feedback', values:[{title: "On", value:0},{title:'Off',value:1},{title:"Never",value:-1}]},
		{title:"● Accept Next URI",type:"dropdown", setting:'accept_nexturi', values:[{title: "Off", value:0},{title:'Force',value:1},{title:"Manual",value:-1}]},
		{title:"● Flac Header",type:"dropdown", setting:'flac_header', values:[{title: "None", value:0},{title:'Set sample and checksum to 0',value:1},{title:"Reinsert fixed",value:2},{title:"Reinsert calculated",value:3}]},
		{title:"● Keep Alive",type:"integer", setting:'keep_alive', min:-1,max:120},
		{title:"● Next Delay",type:"integer", setting:'next_delay',min:0,max:60},
		{title:"● Send Metadata",type:"dropdown", setting:'seend_metadata', values:[{title: "On", value:1},{title:'Off',value:0}]},
		{title:"● Send Cover Art",type:"dropdown", setting:'send_coverart', values:[{title: "On", value:1},{title:'Off',value:0}]}
	]})
	return (l)
}
function heos_get_player_pid_by_name(player_name) {
	if (rheos_players.size) {
		let player =[...rheos_players.values()].find((player) => player?.name?.trim().toLowerCase() === player_name?.trim().toLowerCase())
		return player?.pid 
	}
}
function sum_array(array){
    if (array == undefined  || !isArray(array)) {return 0}
	let total = array?.reduce(function (acc, cur) {return acc + cur}, typeof(array[0])== 'string' ? "" : 0)
	return total
}
function choose_binary(){
	if (os.platform == 'linux') {
		return ('./UPnP/Bin/squeeze2upnp-armv5te-static')	
	} else if (os.platform == 'win32'){
		return('./UPnP/Bin/squeeze2upnp-win.exe')	
	}
}
async function set_permissions(){
	if (os.platform == 'linux') {
		await fs.chmod("./UPnP/Bin/squeeze2upnp-armv5te-static",0o755).catch("ERROR CHANGING MODE")
	}
}
async function group_command_buffer(){
	return new Promise(async function(resolve,reject){
		if(sum_array(rheos_groups.get(group_buffer?.[0]?.[0])?.players.map(player => player.pid))!== sum_array(group_buffer[0])){
			buffer_processing = true
			const  res = await heos_command("group","set_group",{pid : group_buffer[0]}).catch(()=> {group_buffer.shift(); resolve(group_buffer)})
			if (res?.result == "fail") {
				console.log("GROUPING FAILED")
				group_buffer.shift()
				resolve(group_buffer)		
			} else {
				await wait_group_change()
				.catch(err=> {console.error("ERROR",err)
					reject(group_buffer)
				})	
			}
		} else {
			group_buffer.shift()
			resolve(group_buffer)
		}
		if (group_buffer.length){
			let loop = setInterval(()=>{
				if (!group_buffer.length){
					clearInterval(loop)
					group_command_buffer()
					resolve(group_buffer)
				}
			},1000)
		}   
	}
	)
}
async function wait_group_change(){
	return new Promise(async function (resolve,reject){
 		rheos_connection[1].once({ commandGroup: "event", command: "groups_changed" },async (res) =>{
			group_buffer.shift()
			await get_heos_groups()
			buffer_processing = false
			resolve(res)})
		rheos_connection[1].onError(async (error) => {
			group_buffer.shift()
			buffer_processing = false
			if (!res.parsed.eid == 12){console.error("BUFFER",error)}
			reject(res)
		})
	})
}
async function get_heos_groups(){
	const res =	await heos_command("group","get_groups").catch(err=> console.error("GROUP ERROR",err)) 
	rheos_groups.clear()
	if (res.payload){
		for (const group of res.payload){
     		rheos_groups.set(group.gid,group)
		}
	} 		
	return
}
/** "UNTESTED STATIC FILES - to be implented"; squeeze2upnp-x86-64-static ;squeeze2upnp-x86-static ;squeeze2upnp-aarch64-static;squeeze2upnp-armv6hf-static;squeeze2upnp-ppc-static;squeeze2upnp-sparc-static;*/
