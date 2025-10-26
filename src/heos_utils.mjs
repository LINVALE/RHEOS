import { heos_players } from "../config.js"
import { rheos, rheos_groups, rheos_zones, rheos_outputs, services, all_groups, fixed_groups } from "../app.mjs"
import { sum_array, group_ready, unhide_value, hide_value, get_date, sliceStringFromValue, update_zone } from "../src/utils.mjs"
import { TIMEOUT, LOG, LOG_FILE_PATH, PROFILE_PATH, APP } from "../config.js"
import { setTimeout as delay } from "node:timers/promises"
import HeosApi from "heos-api"
import { Heos_player } from "./heos_player.mjs"
import { Heos_group } from "./heos_group.mjs"
import { roon } from "../app.mjs"
import { update_status } from "./utils.mjs"
import fs from "node:fs/promises"
import process, { pid } from "node:process"
import tailfile from "tail-file"
import child from "node:child_process"
const exec = child.execSync
const spawn = child.spawn
export const group_buffer = []
export async function group_dequeue(timer = TIMEOUT) {
	if (rheos.working || !group_buffer.length) {
		return
	}
	const item = group_buffer[0]
	if (!item) {
		return
	}
	rheos.working = true
	if (item.group.length > 1) {
		await heos_command("group", "set_group", { pid: item?.group }, timer, true)
			.catch((err) => { console.error(sum_array(item.group)); item.resolve(err); rheos.working = false; group_dequeue() })
		group_buffer.pop()
		rheos.working = false
		item.resolve()
	}
	else if (item.group.length == 1) {
		rheos_zones.delete(item?.group[0])
		let res = await heos_command("group", "get_groups", timer, true).catch((err) => { console.error("DQ ERROR 1",sum_array(item.group)); item.resolve(err); rheos.working = false; group_dequeue() })
		if (res?.payload?.length && res.payload.find(({ gid }) => gid == item.group[0])) {
			await heos_command("group", "set_group", { pid: item?.group }, timer, false).catch((err) => { console.error("DQ ERROR 2".sum_array(item.group)); item.resolve(err); rheos.working = false; group_dequeue() })
		}
		group_buffer.pop()
		rheos.working = false
		item.resolve()
	}
	await group_dequeue()
}
export async function get_players() {
	return new Promise(function (resolve, reject) {
		if (!rheos.connection) { reject("AWAITING CONNECTION") }
		rheos.connection[0]
			.write("player", "get_players", {})
			.once({ commandGroup: 'player', command: 'get_players' }, async (players) => {
				switch (true) {
					case (players?.payload?.length > 0 && players?.payload.every((p) => p?.pid)): {
						const changed = players.payload.length - (rheos.myplayers == undefined ? 0 : rheos.myplayers.length)
						changed && LOG && console.log("-> ", get_date(), "RHEOS: CHANGED   :", changed, "PLAYERS")
						resolve(players?.payload)
					}
						break
					case (players.heos.result === "failed"): {
						LOG && console.warn("-> ", get_date(), "RHEOS: WARNING  ⚠ UNABLE TO GET PLAYERS")
						console.error(get_date(), "", players)
						reject()
					}
						break
					case (players?.heos.message.unparsed == "command under process"): {
						await delay(2000, "UNDER PROCESS")
						rheos.connection[1]
							.write("player", "get_players", {})
							.once({ commandGroup: 'player', command: 'get_players' }, (players) => {
								if (players?.payload?.length > 0 && players?.payload.every((p) => p?.pid)) {
									LOG && console.log("-> ", get_date(), "RHEOS: IDENTIFIED :", players.payload.length, "RHEOS PLAYERS")
									resolve(players?.payload)
								} else {
									reject("⚠  ERROR GETTING PLAYERS")
								}
							})
					}
						break
					case (players?.payload?.length > 16): {
						console.error("⚠ LIMIT OF 16  HEOS PLAYERS EXCEEDED ", players?.payload?.length)
						reject()
					}
						break
					default: {
						console.error(get_date(), "DEFAULT UNABLE TO GET PLAYERS", players)
						reject()
					}
				}
			})
	})
}	
export async function get_heos_groups(){

	let res = await heos_command("group", "get_groups", TIMEOUT, true).catch((err) => { console.log("ERROR GETTING GROUPS",err)})
		
	
     return res.payload || []
}
export async function update_heos_groups() {
	const players = await get_players()
	const ungroup = []
	for (const player of players) {
		const p = heos_players.get(player.pid)
		if (p?.output && p.player.gid && !player.gid) {
			delete (p.player.gid)	
            ungroup.push(p.output)
		}
		if (p && p.player?.gid) {
			p.gid = player.gid
			if (p.awaiting){
				delete(p.awaiting)
				services.svc_transport.control(heos_players.get(player.gid).zone,'play')
			}
		}
	}
	ungroup.length && services.svc_transport.ungroup_outputs(ungroup)
	return 
}
/**
export function get_group_outputs(group) {
	const players = group.players.sort((a, b) => { let fa = a.role == "leader" ? 0 : 1; let fb = b.role == "leader" ? 0 : 1; return fa - fb })
	for (let player of players) {
		let p = heos_players.get(player.pid)
		if (p) {
			p.player.gid = group.gid
			p?.output && group.outputs.push(p?.output)
		}

	}
}

 */	
 export function   get_group_outputs(g){
        if (!g.players) return([])
        const outputs = []
        const players = g.players.sort((a, b) => { let fa = a.role == "leader" ? 0 : 1; let fb = b.role == "leader" ? 0 : 1; return fa - fb })
                    for (let player of players) {
                        let p = heos_players.get(player.pid)
                        if (p) {
                            p.player.gid = g.gid
                            p?.output && outputs.push(p?.output)
                        }
                    }
        return(outputs)
    } 


export function get_all_groups() {
	all_groups.clear()
	//console.log(Array.from(rheos_zones.values()))
	for (const group of (Array.from(rheos_zones.values().filter(z => z.gid)))) {
		all_groups.set(get_group_sum_group(group._group), group._group)
	}	
	for (const group of Array.from(fixed_groups.values())) {
		all_groups.set(get_group_sum_group(group._group), group._group)
	}
	return all_groups
}
export function get_group_sum_group(group){
	if (group?.players){
		let sum = group.players.reduce((acc,curr)=> acc+curr.pid,0)
		return(sum)
	}else {
		return(0) 
	}
}
	
export function get_player_by_name(name) {
	return [...heos_players.values()].find((player) => { player?.name?.trim().toLowerCase() === name?.trim().toLowerCase() })
}
export async function group_enqueue(group, sum_group) {
	if (Array.isArray(group) && (group = group.filter(o => o))) {
		if (group.length ) {
			return new Promise(async (resolve, reject) => {
				const group_sums = group_buffer.map((o) => o?.sum_group)
				if (group_sums.findIndex((o) => o == sum_group) == -1) {
					LOG && console.log("-> ", get_date(), "HEOS : GROUPING  :", group, sum_group)
					group_buffer.push({ group: group, sum_group: sum_group, resolve, reject })
					group_dequeue().catch((err) => { LOG && console.error(get_date(), "Deque error", err) })
				} else {
					resolve()
				}
			})
		}
	}
}
export function get_zone_group_value(z) {
  let group = {outputs : [], sum_group : 0}
	for (let op of z.outputs){
		if (op.source_controls[0].display_name.includes("RHEOS")){
			let v = unhide_value(op.source_controls[0].display_name)
			group.outputs.push(v)
			group.sum_group = group.sum_group + v
		}
	}
	return(group)
}

export function get_zone_players(z) {
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
export async function heos_command(commandGroup, command, attributes = {}, timer = SHORTTIMEOUT, hidden = false) {
	if (!rheos.connection) {
		LOG && console.warn("-> ", get_date(), "RHEOS: WARNING   ⚠ NO CONNECTION FOUND - RESTARTING RHEOS")
		start_up(true)
		return
	}
	typeof attributes === "object" || ((timer = attributes), (attributes = {}), (hidden = timer))
	!hidden && LOG && console.log("-> ", get_date(), "HEOS : REQUEST   :", commandGroup.toUpperCase(), command.toUpperCase(), attributes)
	return new Promise(async function (resolve, reject) {

		setTimeout(() => { resolve(`Heos command timed out: ${command} ${timer}`) }, timer)

		commandGroup !== "event" && rheos.connection[0].write(commandGroup, command, attributes)


		rheos.connection[0].once({ commandGroup: commandGroup, command: command, attributes }, async (res) => {
			res.parsed = res.heos.message.parsed
			res.result = res.heos.result
			if (res.heos.message.unparsed.includes("under process")) {
				rheos.connection[0].once({ commandGroup: commandGroup, command: command, attributes }, async (res) => {
					resolve(res)
				})
			}
			else if (res.heos.message.unparsed.includes("unknown")) {
				await delay(1000, "UNKOWN")
				commandGroup !== "event" && rheos.connection[0].write(commandGroup, command, attributes)
				rheos.connection[0].once({ commandGroup: commandGroup, command: command, attributes }, (res) => {
					!hidden && LOG && console.log("<- ", get_date(), "RHEOS: COMPLETE  :", res.heos.message.parsed && (JSON.stringify(res.heos.message.parsed || res.heos.message.unparsed)), res.payload || "")
					resolve(res)
				})
			}
			else if (res.heos.message.unparsed.includes("Processing previous command")) {
				await delay(1000)
				console.log(res)
				rheos.connection[0].once({ commandGroup: commandGroup, command: command, attributes }, async (res) => {
					resolve(res)
				})
			}
			else if (res.heos.message.unparsed.includes("Command not executed")) {
				resolve(res)
			}
			else if (res.heos.result === "success") {
				!hidden && LOG && console.log("<- ", get_date(), "RHEOS: COMPLETE  :", res.heos.message.parsed && (JSON.stringify(res.heos.message.parsed || res.heos.message.unparsed)), res.payload || "")
				resolve(res)
			}
			else {


				resolve(res)
			}
		})
	}).catch((err) => {

		LOG && console.warn("-> ", get_date(), "HEOS : WARNING   ⚠ COMMAND FAILED", err)
	})
}
export async function get_outputs(counter = 0, regroup = false) {
	try {
		services.svc_transport.get_outputs(async (err, ops) => {
			if (err || !ops || !ops.outputs.length) {
				return (err || null)
			} else {
				let outputs = ops.outputs.filter((op) => op.source_controls && op.source_controls[0].display_name.includes("RHEOS"))
				if (outputs) {
					for (const o of outputs) {
						if (o.source_controls) {
							const player = heos_players.get(unhide_value(o.source_controls[0].display_name))
							if (player) {
								player.output = o
							}
						}
					}
				} else {
					start_up(true)
				}
				return (Promise.resolve("SUCCESS"))
			}
		})
	} catch {
		services.svc_status.set_status("DISCOVERING PLAYERS AND SETTING GROUPS", true)
		return []
	}
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
		rheos.myplayers = players
		rheos.myplayers.map((p) => { p = new Heos_player(p) })
		players = rheos.myplayers.map((o) => { let { output, timeout, bridge, Z2, PWR, volume, zone, state, status, group, now_playing, position, duration, rheos, next, payload, force_play,awaiting, ...p } = o; return (p) })
		const { payload } = await heos_command("group", "get_groups", TIMEOUT, true).catch(err => console.error(get_date(), err))
		
		/** 
		for (const group of payload) {
			group.outputs = []
			group.sum_group = sum_array(group.players.map(player => player.pid))

			let g = rheos_groups.set(group.gid, new Heos_group).get(group.gid)
console.log(g,group)
			g.group = group

		}

		*/
		if (Array.isArray(players) && players.length) {
			await set_players(players).catch(() => { console.error(get_date(), "RHEOS: ERROR  ⚠ SETTING PLAYERS") })
			let hb = 0
			rheos.heart_beat = setInterval(async () => {
				hb++;
				if (roon?.paired) {
					try {
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
					}
					catch {
						console.error("ERROR CHECKING OUTPUTS PLEASE ENABLE THE RHEOS EXTENSION")
					}
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
export async function monitor_status(hb = 1) {
	await heos_command("system", "heart_beat", TIMEOUT, true).then(async (err) => {
		if (err?.result == "success") {
			hb--
			update_status(false, false)

		} else {
			console.log("-> ", get_date(), "RHEOS: WARNING : ⚠ HEART BEAT FAILED", hb)
			if (hb > 8) {
				clearInterval(rheos.heart_beat)
				await start_heos().catch((err) => { console.error(get_date(), "⚠ Error Restarting Heos", err); reject() })
			}
		}
	})
	return (hb)
}
export async function delete_players(players) {
	if (!Array.isArray(players)) { return }
	const removed = []
	for (const p of players) {
		let pid = p.pid
		if (rheos.processes[pid]?.pid) {
			try {
				process.kill(rheos.processes[pid].pid, 'SIGTERM')
				delete rheos.processes[pid]
				heos_players.delete(pid)
			} catch {
				LOG && console.warn("-> ", get_date(), "RHEOS: WARNING   ⚠ Unable to kill", heos_players.get(pid)?.player?.name.toUpperCase())
			}
		}
	}
	players = rheos.myplayers.map((o) => { let { timeout, bridge, gid, Z2, PWR, volume, zone, state, status, group, now_playing, position, duration, rheos, next, payload, force_play, ...p } = o; return (p) })
	rheos.myplayers = players
	roon.save_config("players", rheos.myplayers);
	return
}
async function create_player(player) {
	const file = LOG_FILE_PATH + player.name.trim() + '.log';
	const content = 'RHEOS * \n';
	LOG && console.log("-> ", get_date(), "RHEOS: WRITING   :", player.name.toUpperCase(), file)
	await fs.writeFile(file, content);
	try {
		let p = rheos.processes[player.pid]
		try {
			if (p?.pid && rheos.processes[player.pid]) {
				p?.pid && process.kill(p.pid, 'SIGKILL');
				rheos.processes[player.pid] && delete (rheos.processes[player.pid])
			}
		} catch {
			console.error("-> ", get_date(), "RHEOS: ERROR    ⚠ KILLING", player.name)
		}
		await set_player_resolution(player).catch(err => { console.log("RESOLUTION",err) })
		if (player.name) {
			rheos.processes[player.pid] = spawn(
				APP,
				['-b', rheos.system_info[0],
					'-Z',
					'-M', hide_value(player.pid) + player.name.trim().toUpperCase() + " (RHEOS: " + player.model + ")",
					'-x', PROFILE_PATH + player.name.trim() + '.xml',
					'-P',
					'-f', LOG_FILE_PATH + player.name.trim() + '.log',
					'-d', 'all=info',
					'-s', rheos.mysettings.host_ip || null
				], { stdio: ['pipe', process.stderr, 'pipe'] }
			)
		}
	} catch (player) {
		LOG && console.warn("-> ", get_date(), "RHEOS: WARNING   ⚠ UNABLE TO CREATE PLAYER", player?.name)
	}
	rheos.processes[player.pid].on('uncaughtExceptionMonitor', async (err, origin) => {
		console.error("-> ", get_date(), "RHEOS: EXCEPTION    :", player.name.toUpperCase(), err, origin)
	})
	rheos.processes[player.pid].on('exit', async () => {
		LOG && console.log("-> ", get_date(), "RHEOS: KILLED    :", player.name.toUpperCase(), " - ", heos_players.get(player.pid)?.player?.output || "not activated")
	})
	rheos.processes[player.pid].on('spawn', async () => {
		LOG && console.log("-> ", get_date(), "RHEOS: CREATED   :", player.name.toUpperCase())
		const rheosTail = new tailfile("./UPnP/Logs/" + player.name.trim() + ".log", async line => {
			if (line.includes("set current URI")) {
				const bridge = sliceStringFromValue(line, "http")
				const p = heos_players.get(player.pid)
				if (p?.is_leader() && p?.payload?.mid == '1') {
					//clearTimeout(p.timeout)
					//	p.timeout = setTimeout(async ()=>{	
					//	const zone = services.svc_transport.zone_by_zone_id(p.zone)
					//if (zone?.is_play_allowed){
					//	await services.svc_transport.control(zone,'play')
					//}

					console.log('\x1b[31m%s\x1b[0m',"->  "+  get_date()+ " RHEOS: BRIDGED   : "+ p.mode.toUpperCase()+ " " + p?.now_playing?.two_line?.line1.slice(0,200), bridge)
					//},1000)	
				}
				return (rheos.processes[player.pid])
			}
		})
	})
}
async function set_player_resolution(player) {

	LOG && console.log("-> ", get_date(), "RHEOS: SETTING   : PLAYER RESOLUTION", player.name.toUpperCase())
	let device = {}
	device.udn = player.udn || player.gid
	device.friendly_name = player.name
	switch (player.resolution) {
		case ("HR"): {
			device.enabled = '1'
			device.mode = ("flc:0,r:-192000,s:24").toString().concat(rheos.mysettings.flow ? ",flow" : "")
			device.sample_rate = '192000'
		}
			break
		case ("THRU"): {
			device.enabled = '1'
			device.mode = ("thru")
			device.sample_rate = '192000'
		}
			break
		case ("LOW"): {
			device.enabled = '1'
			device.mode = ("flc:0,r:-48000,s:16").toString().concat(rheos?.mysettings?.flow ? ",flow" : "")
			device.sample_rate = '48000'
		}
			break
		default: {
			device.enabled = '1'
			device.mode = ("thru")
			device.sample_rate = '192000'
		}
	}
	switch (player.mode) {
		case ("OFF"): {
			device.flow = "0"
			device.send_metadata = "0"
			device.send_coverart = "0"
		}
			break
		case ("META"): {
			device.flow = "0"
			device.send_metadata = "1"
			device.send_coverart = "1"
		}
			break
		case ("ART"): {
			device.flow = "0"
			device.send_metadata = "1"
			device.send_coverart = "1"
		}
			break
		default: {
			device.flow = "0"
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
	await fs.writeFile("./UPnP/Profiles/" + (player.name.trim()) + ".xml", template).catch(() => { console.error(get_date(), "⚠ Failed to create template for " + device.name[0]) })
	const saved_player = rheos.myplayers.find(({ pid }) => pid == player.pid)
	if (saved_player) {
		saved_player.resolution = player.resolution
		saved_player.mode = player.mode
	}



	player = new Heos_player(player)
	heos_players.set(player.player.pid, player)

}
export async function set_players(players) {
	if (!Array.isArray(players) || !players.length) { return }
	for await (const player of players) {
		LOG && console.log("-> ", get_date(), "RHEOS: SETTING   :", player.name, " - ", player.model, " - ", player.ip)
		if (player?.pid && typeof (player) === "object") {
			const p = rheos?.myplayers?.find(({ pid }) => pid == player.pid)
			if (p) {
				const { resolution = "", mode = "FLOW", auto_play, udn, ip } = p
				rheos.mysettings["P" + String((player.pid))] = (resolution ? resolution : player.model.includes("HEOS") ? "CD" : "THRU")
				rheos.mysettings["M" + String((player.pid))] = mode
				rheos.mysettings["A" + String((player.pid))] = (auto_play || "OFF")
				if (!ip) {
					console.warn(get_date(), player.name.toUpperCase(), "Unable to get player ip")
					let p = await heos_command("player", "get_player_info", { pid: player.pid }, 1000, true)
					if (p?.payload?.ip) {
						player.ip = p?.payload?.ip
					} else { continue }
				}
				if (!udn) {
					if (player.ip) {
						const info = await get_device_info(player.ip, player.name).catch(() => { console.error(get_date(), "Unable to get player UDN", player.name) })
						if (info?.length == 2) {
							player.udn = (info[0])
							player.mac = (info[1])
						}
					} else {
						continue
					}
				}
				player.resolution = ((resolution ? resolution : player.model.includes("HEOS") ? "CD" : "THRU"))
				player.mode = (mode ? mode : "FLOW")

				await create_player(player).catch(() => { console.error(get_date(), "Failed to create player", player) })
			}
		}
	}


	console.table(Array.from(heos_players.values(), (o) => o.player), ["name", "pid", "model", "udn", "ip", "resolution", "network", "mode"])
	return
}
async function get_device_info(ip, name) {
	if (!ip) {
		console.log("NO IP", ip)
		return
	}
	try {
		console.log("-> ", get_date(), "RHEOS: DISCOVERED: GETTING INFO FOR", name, "@", ip)
		const response = await fetch('http://' + ip + ':60006/upnp/desc/aios_device/aios_device.xml').catch(err => console.error(err))
		if (!response.ok) { throw new Error(`Fetch failed: ${response.status}`) }
		const body = await response.text().catch(err => console.error("FETCH FAILED",err))
		let re = new RegExp("<UDN>(.*?)</UDN?>")
		const upn = body.search(re)
		re = new RegExp("<lanMac>(.*?)</lanMac?>")
		const mac = body.search(re)
		return ([body.slice(upn + 5, upn + 46), body.slice(mac + 8, mac + 25)])
	} catch (error) { console.error('Error fetching data:', error) }
}
async function reboot_heos_server() {
	let res = await heos_command("system", "reboot", 20000)
	console.log("REBOOTING SYSTEM", res)
}
