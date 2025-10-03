

import {group_enqueue,heos_command} from "./heos_utils.mjs";
//import { heos_command } from "../heos_command.mjs";
import {rheos,rheos_groups,rheos_zones,rheos_outputs,services,all_groups,fixed_groups} from "../app.mjs"
import {sum_array,group_ready,unhide_value,hide_value,get_date} from "../src/utils.mjs"
import {LOG,TIMEOUT,SHORTTIMEOUT,heos_players} from '../config.js'
class Heos_player{
  constructor(player) {
    this._player = player; 
    this._zone = null;
    this._sum_group = player.pid;
    this._output = player.output;
    this._player.volume = {level: player?.volume || 0, state: player?.is_muted ? "on" : "off"}; 
    this._player.group = null; 
    this._player.payload = {}; 
    heos_command("player", "get_volume",{pid : player.pid},1000,true).then((res) => this._player.volume.level = res.parsed.level)
    heos_command("player", "get_mute",{pid : player.pid},1000,true).then((res) => this._player.volume.state = res.parsed.state)
  }
  static is_leader(){
    Boolean(this.pid == this.gid || !this.gid)
  }
  get saved_player_info() {
    const {zone,volume,state,status,group,now_playing,position,duration,rheos,next,payload,force_play, ...p} = this._player
    p.output = this._output?.output_id
    return p
  }
  get player (){
    return this._player 
  }
  get pid (){
    return this._player.pid
  }
  get name (){
    return this._player?.name || this
  }
  get status (){
    return this._player.status
  }
  get state (){
    return this._player.state
  }
  set now_playing (np){
    this._player.now_playing = np
  }
  get udn (){
    return this._player.udn
  }
  get mode (){
    return this._player.mode
  }
  get now_playing (){
    return this._now_playing
  }
  get position (){
    return this._player.position
  }
  get duration (){
    return this._player.duration
  }
  get group (){
    return this._player.group
  }
  get force_play (){
    return this._player.force_play
  }
  get next (){
    return this._player.next
  }
  get type(){
    return this._player.type
  }
  get payload (){
    return this._player.payload
  } 
  set payload (p){
    const {mid = "",song = "",sid = ""} = p;	
    if (mid && song !== this.payload?.song){	
      if (mid < 2 ) {		
        (Heos_player.is_leader(this.player)) &&  console.log("-> ",get_date(),"RHEOS: PLAYING   :",this.name.toUpperCase(),this.mode!=="FLOW" ? (palbum+","+p.song) : p.song)
      }	  		
    else if (this.player?.payload?.mid !== '1' && this.zone) {	
      console.log("-> ",get_date(),"OTHER: PLAYING   :",this.name.toUpperCase(),"TO",song,sid,mid)			
      services.svc_transport.control(this.zone,"stop", async() =>{
        setTimeout(async ()=> {
            await heos_command("player", "set_play_state",{pid : this.pid, state : "play"},TIMEOUT,true)	
        },500)
      });	
      (Heos_player.is_leader(this.player)) &&  console.log("-> ",get_date(),"OTHER: PLAYING   :",this.name.toUpperCase(),p.album,",",p.song)
      }   
    }
    this._player.payload = p
  }
  set zone(zone) {
   let outputs = zone.outputs.filter(o => o.source_controls[0].display_name.includes("RHEOS"))
   const sum = outputs.reduce((acc, op) => acc + (unhide_value(op.source_controls[0].display_name)), 0)
   const sum_group = zone.outputs.filter((o) => o.source_controls[0].display_name.includes("RHEOS")).map(op => unhide_value(op.source_controls[0].display_name))
   if (this.awaiting){
    if (sum && this.awaiting.sum_group == sum ){
      if ( [...rheos_groups.values()].findIndex((g) => g.sum_group ===sum_group) == -1){
        this._sum_group = sum
        console.log("-> ",get_date(),"HEOS : ZONE      : GROUP CREATED AND LEAD BY PLAYER",this._player.name,"TO",this._sum_group)
        group_enqueue(this.awaiting.heos_group,sum_group).catch(()=>{console.log("ALREADY GROUPED",this.awaiting.group)})
      } 
    }
    if (this.awaiting && zone.now_playing?.one_line?.line1 === this.awaiting?.now_playing?.one_line?.line1){
      console.log("-> ",get_date(),"HEOS : FIXED     : GROUP HAS TRANSFERRED ",this.awaiting?.now_playing?.one_line?.line1, "TO",this._player.name)
      services.svc_transport.group_outputs(this.awaiting.group)
    } 
    if (this.awaiting?.sum_group == sum && zone.outputs.length ==  this.awaiting.group.length && [...rheos_groups.values()].findIndex((g) => g.sum_group == sum)>-1){
      console.log("-> ",get_date(),"HEOS : FIXED     : GROUP HAS FORMED ",zone.display_name,this.awaiting?.sum_group, sum )
      if(zone?.is_play_allowed){
        console.log("-> ",get_date(),"HEOS : FIXED     : GROUP IS READY TO PLAY ",zone.display_name)
              setTimeout(async ()=> {
              services.svc_transport.control(zone,'play')
        },500)
      }
      if (zone?.state == "playing"){
        console.log("-> ",get_date(),"HEOS : FIXED     : GROUP IS", zone?.state.toUpperCase(),zone.display_name)
        this.awaiting = null
      } 
    }
   }
    this._zone = zone
  }       
  get zone() {
    return this._zone;
  }
  set output(output) {
    if (this.player){
    (async ()=>{
        const{is_muted,value} = output.volume || {}
        if (this._player?.volume?.level !== value ){
          LOG && console.log("<- ",get_date(),"RHEOS:",this._volume ?"UPDATING  :" : "SETTING   :",this._player.name.toUpperCase(),"VOLUME",value, this._volume ? "FROM" : "",this._player.volume.level || "")	
          
          await heos_command("player", "set_volume", { pid: this._player.pid, level: value > 0 ? value  : 0 },200,true).catch(err => console.error(get_date(),err))	
        }
        if (this._player?.volume?.state  !== (is_muted ? "on" : "off")){ 
          LOG && console.log("<- ",get_date(),"RHEOS:",this._volume ?"UPDATING  :" : "SETTING   :",this._player.name.toUpperCase(),"MUTE",(is_muted?"ON":"OFF"))
          await heos_command("player", "set_mute", { pid: this._player.pid, state: is_muted ? "on": "off"},200,true).catch(err => console.error(get_date(),err))
        }
      })()
    }
  this._output = output;
  }
  get output() {
    if (this._output){
      return this._output
    } else {
      this._output = Array.from(rheos_outputs.values(0)).find(o => o.output_id == unhide_value(o.source_controls[0].display_name)== this._pid)
      return this._output}
  }
  set volume(vol) {   
   if(vol.level !== this._player?.volume?.level){
    this._player.volume.level = vol.level
   } 
    if(vol.state !== this._player?.volume?.state){
    this._player.volume.state = vol.state
   }   
  }
  get volume (){
   return this._player.volume
  } 
  get sum_group(){
    return this._sum_group
  }
  
 is_leader(){
  return (this.gid && this.pid == this.gid)
 }
}
export {Heos_player}