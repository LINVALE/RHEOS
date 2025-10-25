import {heos_players} from "../config.js"
import {rheos,rheos_groups,rheos_zones,rheos_outputs,services,all_groups,fixed_groups } from "../app.mjs"
import {sum_array,group_ready,unhide_value,hide_value,get_date} from "../src/utils.mjs"
import {LOG, TIMEOUT, SHORTTIMEOUT } from "../config.js"
import { get_players,heos_command,set_players,delete_players,start_heos, update_heos_groups} from "./heos_utils.mjs"
import {Heos_group} from "./heos_group.mjs"
//import { update_avr_status } from "./avr_utils.mjs"
export async function listeners() {
	rheos.listeners = true
	rheos.connection[0].socket.setMaxListeners(64)
	rheos.connection[1].socket.setMaxListeners(64)
	rheos.connection[0].write("system", "register_for_change_events", { enable: "on" })
	.onClose(async (hadError,msg) => {setTimeout(async ()=>{
		console.error(get_date(),"⚠ Listeners closed socket 0", hadError,msg)
		await start_heos().catch((err) => {console.error(get_date(),"⚠ Error Starting Heos",err);reject()})
		},TIMEOUT)
	})
	rheos.connection[1].write("system", "register_for_change_events", { enable: "on" })
	.onClose(async (hadError,msg) => {setTimeout(async ()=>{
		console.error(get_date(),"⚠ Listeners closed Socket 1", hadError,msg)
		console.log("STARTING HEOS AGAIN")
		await start_heos().catch((err) => {console.error(get_date(),"⚠ Error Starting Heos",err);reject()})
		},1000)
	})
	.onError((err) => {
		console.error(get_date(),"HEOS : ERROR :⚠", err)})
	.on({ commandGroup: "event", command: "groups_changed" }, async (res) => {
		LOG && console.log("-> ",get_date(),"HEOS : EVENT     : GROUPS CHANGED - UPDATING HEOS GROUPS")
		res = await heos_command("group", "get_groups", TIMEOUT, false).catch(err => console.error(get_date(), err))
		for (let g of res?.payload){
            let group = rheos_zones.get(g.gid)
            if (!group){	
				group =rheos_zones.set(g.gid,new Heos_group(g)).get(g.gid)   
			}
			group.group = g
		}
		await update_heos_groups().then(LOG && console.log("-> ",get_date(),"HEOS : EVENT     : HEOS GROUPS UPDATED")).catch(err => console.error(get_date(),"⚠ Error Updating HEOS Groups",err))							
	})
	.on({ commandGroup: "event", command: "players_changed" }, async (res) => {
		LOG && console.log("-> ",get_date(),"HEOS : EVENT     : PLAYERS CHANGED")
	    clearTimeout(rheos.check_players)
		rheos.check_players = setTimeout(async () =>{
			LOG && console.log("-> ",get_date(),"HEOS : CHECK     : PLAYERS CHANGED")
			const players = await get_players().catch(() => {(console.error(get_date(),"Failed to create players - recomparing"))})
			const new_players = players.filter((p) => Array.from(heos_players.values(), (o) => o.player).findIndex((o) => o.pid == p.pid) <0)
				if (new_players.length ){
					LOG && console.log("-> ",get_date(),"HEOS : ADDED    : ",new_players.map(p =>p.name))
					await set_players(new_players).catch((err)=>{console.error("-> ",get_date(),"RHEOS: ⚠ ERROR   : SETTING PLAYERS 1", err)})
				} 	
			const removed_players = Array.from(heos_players.values(), (o) => o.player).filter((p) => players.findIndex((player) => player.pid == p.pid ) <0)
				if (removed_players.length){	
					LOG && console.log("-> ",get_date(),"HEOS : REMOVED: ",removed_players.map(p =>p.name))
					await delete_players(removed_players)
				}
		},SHORTTIMEOUT)	
	})
	.on({ commandGroup: "event", command: "player_now_playing_changed" }, async (res) => {
		const player =  heos_players.get(res.heos.message.parsed.pid)
		if(player){
			const {payload = {} } = await heos_command("player", "get_now_playing_media",{pid : player.pid},TIMEOUT,true)
			player.payload = payload
			//if (player.type == "AVR"){
			//	await update_avr_status(player,'now_playing changed')
			//}
		}	
	})
	.on({ commandGroup: "event", command: "player_state_changed" }, async (res) => {	
		const {pid,state = "unknown"} = res.heos.message.parsed
		const player =  heos_players.get(pid)?.player
        if (player){
			player && LOG && console.log("-> ",get_date(),"HEOS : EVENT     :",player?.name.toUpperCase(),"STATE CHANGED ",JSON.stringify(res.heos.message.parsed))
			player.state = state
		} else {
			console.log("PLAYER NOT RECOGNIZED",pid)
		}

	})
	.on({ commandGroup: "event", command: "repeat_mode_changed" }, async (res) => {
		LOG && console.log("-> ",get_date(),"HEOS : EVENT     :","REPEAT MODE ",JSON.stringify(res.heos.message.parsed.repeat))
		const {pid,repeat} = res.heos.message.parsed
		const zone = services.svc_transport.zone_by_output_id(heos_players.get(pid)?.player?.output) 
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
		LOG && console.log("-> ",get_date(),"HEOS : EVENT     :","SHUFFLE ",JSON.stringify(res.heos.message.parsed.shuffle))
		const {pid,shuffle} = res.heos.message.parsed
		const zone = services.svc_transport.zone_by_output_id(heos_players.get(pid)?.player?.output) 
		if (zone){
			services.svc_transport.change_settings(zone,{shuffle : shuffle == "on"  })
		}
	})
	.on({ commandGroup: "event", command: "player_playback_error" }, async(res) => {
		const {pid,error} = res.heos.message.parsed;
		const player = heos_players.get(pid).player;
		if (player){
			console.log("-> ",get_date(),"RHEOS: WARNING   ⚠",player.name.toUpperCase(),error)
		}
	})	
	.on({ commandGroup: "event", command: "player_volume_changed" }, async (res) => {
		const { heos: { message: { parsed: { mute, level, pid } } } } = res
		const player = heos_players.get(pid)
		if(player?.output){
			if (player.volume.value !== level || player?.volume?.state !== (mute == 'on')){
				player.volume = {level : level, state : mute}
				services.svc_transport.change_volume(player.output, 'absolute', level)	
                services.svc_transport.mute(player.output, (mute == 'on' ? 'mute' : 'unmute'))	
            }
        }    	
	})
    .on({ commandGroup: "event", command: "group_volume_changed" }, async (res) => {
		const { heos: { message: { parsed: { level , gid } } } } = res
        let fixed = fixed_groups.get(rheos_zones.get(gid)?.sum_group)
        if (fixed) fixed.volume = level
    })
    .on({ commandGroup: "event", command: "group_mute_changed" }, async (res) => {
		const { heos: { message: { parsed: { mute : state,  gid } } } } = res
        let fixed = fixed_groups.get(rheos_zones.get(gid)?.sum_group)
        if (fixed) fixed.mute = state
    })
}
