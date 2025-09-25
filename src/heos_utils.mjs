import {heos_players} from "../config.js"
import {rheos,rheos_groups,rheos_zones,rheos_outputs,services,all_groups,fixed_groups} from "../app.mjs"
import {sum_array,group_ready,unhide_value,hide_value,get_date} from "../src/utils.mjs"
import { TIMEOUT } from "../config.js"
import {LOG} from "../config.js"
import { setTimeout  as  delay} from "node:timers/promises"
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
	if (item.group.length >1 ){
		await heos_command("group", "set_group", { pid: item?.group },timer,true)
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
export async function get_players() {
	return new Promise(function (resolve, reject) {
		if (!rheos.connection) {reject("AWAITING CONNECTION")}
		rheos.connection[1]
		.write("player", "get_players", {})
		.once({ commandGroup: 'player', command: 'get_players' }, async(players) => {
			switch(true){
				case ( players?.payload?.length > 0 && players?.payload.every((p)=> p?.pid)) : {
					const changed = players.payload.length - (rheos.myplayers == undefined ? 0 : rheos.myplayers.length)
					changed && LOG && console.log("-> ",get_date(),"RHEOS: CHANGED   :",changed, "PLAYERS")
					resolve(players?.payload)
				}	
				break
				case (players.heos.result === "failed"):{ 
					LOG && console.warn("-> ",get_date(),"RHEOS: WARNING  ⚠ UNABLE TO GET PLAYERS")
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
							LOG && console.log("-> ",get_date(),"RHEOS: IDENTIFIED :",players.payload.length, "RHEOS PLAYERS")
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
export async function update_heos_groups() {
	const players = await get_players()
	 const ungrouped = new Set()
	for (const player of players){
		const p = heos_players.get(player.pid)
		if (!p){
			create_player(player)
		}
		if (p?.output && p.gid && !player.gid ){
			ungrouped.add(p.output)
			delete(p.gid)
		} 
		else if (p && p.player?.gid){
			p.gid = player.gid
		}
	}
	ungrouped.size && services.svc_transport.ungroup_outputs([...ungrouped])		
	return new Promise(async function (resolve) {
		const res = await heos_command("group", "get_groups",TIMEOUT,false).catch(err => console.error(get_date(),err))
		if (res?.payload?.length) {
			for await (const group of res.payload) {
				group.outputs = []
				group.sum_group = sum_array(group.players.map(player => player.pid))
				rheos_groups.set(group.gid,group)
				const players =	group.players.sort((a, b) => {let fa = a.role == "leader" ? 0 : 1; let fb = b.role == "leader" ? 0 : 1; return fa - fb} )
				for await (let player of players){
					let p = heos_players.get(player.pid)
					p.player.gid = group.gid
					p?.output && group.outputs.push(p?.output)				
				}
				services.svc_transport.group_outputs(group.outputs,(err)=> err && console.error("ERROR GROUPING OUTPUTS",err))
				group_ready.emit("GROUP",group.sum_group,group.length)
			}	
		} else {
			rheos_groups.clear()
		
		}
		resolve("SUCCESS")
	}).catch(err => console.error(get_date(),err))
}
export function get_all_groups(){
	all_groups.clear()
	console.log("RHEOS GROUPS",rheos_groups)
	console.log("FIXED GROUPS",fixed_groups)
	for (const group of rheos_groups){
		all_groups.set(group.sum_group,group[1])
	}
	for (const group of [...fixed_groups.values()]){
		console.log("SETTING FIXED GROUP",group)
		all_groups.set(group.sum_group,group)
	}
	console.log("ALL GROUPS ARE",all_groups)
	return all_groups
}
export function get_player_by_name(name) {
	return [...heos_players.values()].find((player) => {player?.name?.trim().toLowerCase() === name?.trim().toLowerCase()})
}
export async function group_enqueue(group,sum_group) {
	if (Array.isArray(group) && (group = group.filter(o => o))){
		if (group){
			LOG && console.log("-> ",get_date(),"HEOS : GROUPING  :",group)
			return new Promise(async (resolve, reject) => {
			const group_sums = group_buffer.map((o) => o?.sum_group)
			if(group_sums.findIndex((o) => o == sum_group) == -1){
				group_buffer.push({ group : group,sum_group : sum_group, resolve, reject })	
			} 
			group_dequeue().catch((err)=>{LOG && console.error(get_date(),"Deque error",err)})	
		})
		}
	}
}
export async function heos_command(commandGroup, command, attributes = {}, timer = SHORTTIMEOUT, hidden = false) {	
	if (!rheos.connection) {
		LOG && console.warn("-> ",get_date(),"RHEOS: WARNING   ⚠ NO CONNECTION FOUND - RESTARTING RHEOS")
		start_up(true)
		return
	}
	typeof attributes === "object" || ((timer = attributes), (attributes = {}),(hidden = timer))
	!hidden && LOG && console.log("-> ",get_date(),"HEOS : REQUEST   :",commandGroup.toUpperCase(), command.toUpperCase(), attributes)
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
					!hidden && LOG && console.log("<- ",get_date(),"RHEOS: COMPLETE  :",res.heos.message.parsed && (JSON.stringify(res.heos.message.parsed || res.heos.message.unparsed)),res.payload || "")
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
				!hidden && LOG && console.log("<- ",get_date(),"RHEOS: COMPLETE  :",res.heos.message.parsed && (JSON.stringify(res.heos.message.parsed || res.heos.message.unparsed)),res.payload || "")
				resolve(res)
			}
			else {
				
				
				resolve(res)	
			}		
		})
	}).catch((err)=> {

		LOG && console.warn("-> ",get_date(),"HEOS : WARNING   ⚠ COMMAND FAILED",err)
	})
}
export async function get_outputs(counter = 0,regroup = false){
	try{
		services.svc_transport.get_outputs(async (err,ops)=> {
			if(err || !ops || !ops.outputs.length){
				return (err || null)
			} else {
				let outputs = ops.outputs.filter((op) => op.source_controls && op.source_controls[0].display_name.includes("RHEOS"))
				if (outputs){
					for (const o of outputs){
						if (o.source_controls){
							const player = heos_players.get(unhide_value(o.source_controls[0].display_name))
							if (player){
								player.output = o
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
