import {group_enqueue,heos_command} from "./heos_utils.mjs";
import {spawn} from "node:child_process"
import {rheos,rheos_groups,rheos_zones,rheos_outputs,services,all_groups,fixed_groups,squeezelite } from "../app.mjs"
import {sum_array,group_ready,unhide_value,hide_value,get_date} from "../src/utils.mjs"
import {LOG, TIMEOUT,heos_players } from "../config.js"
class Fixed_group {
    constructor(group){
        this._group = group;
        const fixed = Math.abs(group.sum_group).toString(16);
        group.display_name = hide_value(group.sum_group)+"🔗 " + group.name
        console.log("-> ",get_date(),"RHEOS: FIXED GRP :",group.display_name,"RESOLUTION",group.resolution || "CD","SUM GROUP ID",group.sum_group,"HEX ID",fixed)
        if (!rheos.processes[fixed]){	
            const mac = "bb:bb:bb:"+ fixed.replace(/..\B/g, '$&:').slice(1,7)
            LOG && console.log("-> ",get_date(),"RHEOS: SPAWNING  : FIXED GROUP",group.display_name,mac,fixed)
            rheos.processes[fixed] = spawn(squeezelite,[
                "-M",group.display_name,
                "-m",mac,
                "-r",group.resolution || 48000,
                "-o", '-',
                '-s',  rheos.mysettings.host_ip,
                '-f','./UPnP/Logs/' + group.display_name + '.log'])
        } else {
            LOG && console.log("-> ",get_date(),"RHEOS: WARNING   ⚠ FIXED GROUP ALREADY RUNNING",group.display_name)
        }
    }
    set output(op){
        this._output = op 
		const group = [...rheos_groups.values()].find(g => g.sum_group == (this._group?.sum_group))
        if (group){
            group.fixed_output = op
            rheos_outputs.set(op.output_id,op)
            heos_command("group", "get_volume",{gid : group.gid},TIMEOUT,true).then((vol) => {
                if (vol?.result == 'success') {
                let {parsed:{level}}  = vol
                if (level !== op.volume?.value ){
                    heos_command("group", "set_volume",{gid : group.gid, level : op.volume.value},TIMEOUT,true)
                }
            }
            })
            heos_command("group", "get_mute",{gid : group.gid},TIMEOUT,true).then((mute)=>{
                if (mute?.result == 'success' && ((mute.parsed.state == "on") !== op.volume?.is_muted)){
                    heos_command("group", "set_mute",{gid : group.gid, state : op.volume?.is_muted ? "on" : "off"},TIMEOUT,true)
                }  
            })
                
        } 
    }
    set zone(z){
        if (this._group){
            let player = heos_players.get(this._group.players.find(p => p.role == 'leader')?.pid) 
            if ((z.outputs?.length == 1) && (z.state == 'playing')) {
                const max_vol = 40
                player.awaiting = {
                    now_playing : z.now_playing, 
                    group : this.group_outputs.concat([this._zone.outputs[0].output_id]),
                    heos_group : this._group.players.sort((a, b) => {let fa = a.role == "leader" ? 0 : 1; let fb = b.role == "leader" ? 0 : 1; return fa - fb}).map(p => p.pid),	
                    sum_group : this._group.sum_group
                }
                console.log("-> ",get_date(),"RHEOS: REQUEST  : TRANSFER FROM",this._output.display_name,"TO", player.name)
                services.svc_transport.transfer_zone( z,player.awaiting.group[0],	async (err) => { 
                    if (err){
                        console.error("-> ",get_date(),"RHEOS: TRANSFER  ⚠ ERROR - unable to transfer to destination output",this._group.outputs[0].display_name)
                    } 	
                })
            } else if (z.state == "paused" && player?.awaiting === null){
                    services.svc_transport.ungroup_outputs(this.group_outputs)    
            } 
        this._zone = z
        } 
    }
    get zone(){
        return this._zone
    }
    get group(){
        return this._group
    }
    get gid (){
        return this._group.gid
    }
    set gid (gid){
        this._group.gid = gid
    }
    get sum_group (){
        return this._group.sum_group
    }
    get name(){
        return this._group.name
    }
    get output(){
        return this._output
    }
    get lead(){
        return(heos_players.get((this._group.players).find(p => p.role == 'leader').pid))
    }
    get group(){
        return this._group
    }
    get group_outputs(){
    if (this._group.players){
          return (this._group.players.map((p)=>{return (heos_players.get(p.pid)?.output?.output_id)}))
        } else {  
            return []
        }
    }
    get players(){
        if (this._group.players){
            return (this._group.players.map((p)=> (heos_players.get(p.pid))))
        } else {  
            return []
        }
    }
    get outputs(){
        return this._group.players.map((p)=>{heos_players.get(p.pid)?.output})
    }  
    get volume (){
        return this._output?.volume.value
    } 
    set volume(value){
        if (this._output?.volume.value !== value){
          services.svc_transport.change_volume( this._output,'absolute',value)   
        }
    }
    get mute (){
        return this._output.volume.is_muted
    }
    set mute(mute){
        if (this._output?.volume.is_muted !== (mute == 'off')){
          services.svc_transport.mute( this._output,mute == 'on' ? 'mute' : 'unmute')   
        }
    }
    sum_zone(outputs){


    }
}
export {Fixed_group}