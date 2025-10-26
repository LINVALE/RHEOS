

import {group_enqueue,heos_command,get_zone_group_value} from "./heos_utils.mjs";
//import { heos_command } from "../heos_command.mjs";
import fs from "node:fs/promises"
import {rheos,rheos_groups,rheos_zones,rheos_outputs,services,all_groups,fixed_groups} from "../app.mjs"
import {sum_array,group_ready,unhide_value,hide_value,get_date} from "../src/utils.mjs"
import {LOG,TIMEOUT,SHORTTIMEOUT,heos_players,image_server} from '../config.js'
class Heos_player{
  constructor(player) {
    this._player = player; 
    this._zone = null;
    this._sum_group = player.pid;
    this._output = player.output;
    this._player.volume = {level: player?.volume || 0, state: player?.is_muted ? "on" : "off"}; 
    this._player.group = null; 
    this._player.payload = {}; 
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
  set state(state){
    console.log("-> ",get_date(),"HEOS : SETTING   :",this._player?.name.toUpperCase(),"STATE TO",state)
    this._player.state = state


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
    return this._zone?.now_playing
  }
  get position (){
    return this._zone?.now_playing?.seek_position || 0
  }
  get duration (){
    return this._zone?.now_playing?.duration || 0
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
  get awaiting (){
    return this._player.awaiting || false
  }
  set payload (p){
    const {mid = "",song = "",sid = ""} = p;	
    if (mid && song !== this.payload?.song){	
      if (mid < 2 ) {		
        (this.is_leader) &&  console.log("-> ",get_date(),"RHEOS: PLAYING   :",this.name.toUpperCase(),(this.mode!=="FLOW" ? (p.album+","+p.song) : p.song).slice(0,200))
      }	  		
    else if (this.is_leader() && this.player?.payload?.mid !== '1' && this.zone) {	
      console.log("-> ",get_date(),"OTHER: PLAYING   :",this.name.toUpperCase(),"TO",song,sid,mid)			
      services.svc_transport.control(this.zone,"stop", async() =>{
        setTimeout(async ()=> {
            await heos_command("player", "set_play_state",{pid : this.pid, state : "play"},TIMEOUT,true)	
        },500)
      });	
      (this.is_leader()) &&  console.log("-> ",get_date(),"OTHER: PLAYING   :",this.name.toUpperCase(),p.album,",",p.song)
      }   
    }
    this._player.payload = p
  }
  set zone(zone) {
    LOG && console.log("<- ",get_date(),"RHEOS: SETTING   : ZONE  ",zone.display_name,zone.state)
    if(this.is_leader() && this.payload){
      const player = this._player
      let {mode,name,state,gid,pid,payload,payload :{mid}} = player
      if (mid =='1' && this.is_leader()){
        player._zone = zone
        if (zone.state == "paused" && !player.awaiting?.now_playing) {
          LOG && console.log("<- ",get_date(),"RHEOS: STOPPING  :", (rheos_zones.get(gid)) ? "GROUP".padEnd(10," ")+"- "+name: "PLAYER".padEnd(10," ")+"- "+name.toUpperCase(),mode,state,zone.now_playing?.three_line.line1 || "NOTHING PLAYING")		
          heos_command("player", "set_play_state",{pid : pid, state : "stop"},TIMEOUT,true)
        }				
      } else if(state == "play" &&  mid !== "1" && this.is_leader(player)){
        if (zone.state == "playing" ){
          LOG && console.log("<- ",get_date(),"RHEOS: STOPPING  : NON RHEOS STREAM STARTED PLAYING ON HEOS PLAYER",zone.display_name,zone.now_playing?.one_line?.line1)
        } 	
      }  
    }
  const sum = get_zone_group_value(zone).sum_group
  
  if (this?.awaiting?.now_playing){
    if ((this.awaiting?.group && this.awaiting?.sum_group != sum ) && zone.now_playing?.one_line?.line1 === this.awaiting?.now_playing?.one_line?.line1){
      console.log("-> ",get_date(),"HEOS : FIXED     : GROUP HAS TRANSFERRED ",this.awaiting?.now_playing?.two_line?.line1.slice(0,200), "TO",this._player.name)
      services.svc_transport.group_outputs(this.awaiting.group,(err)=>(err && console.log( "-> ",get_date(),"RHEOS : FIXED     :ERROR GROUPING")) )
    } 
    if (this.awaiting?.sum_group == sum && zone.outputs.length ===  this.awaiting.group.length ){//&& zone.now_playing?.one_line?.line1 === this.awaiting?.now_playing?.one_line?.line1){
      console.log("-> ",get_date(),"HEOS : FIXED     : GROUP HAS FORMED ",zone.display_name,this.awaiting?.sum_group, sum )
        if(zone.state == 'paused' && zone?.is_play_allowed){
            console.log("-> ",get_date(),"HEOS : FIXED     : GROUP IS READY TO PLAY ",zone.display_name)
                  setTimeout(async ()=> {
                  services.svc_transport.control(zone,'play')
            },500)
          }
          if (zone?.state == "playing" || zone?.state == 'loading'){
            console.log("-> ",get_date(),"HEOS : FIXED     : GROUP IS",zone?.state.toUpperCase(),zone.display_name)
            delete(this._player.awaiting)
          } 
    }
    if(this.awaiting?.sum_group == sum && zone.outputs.length !==  this.awaiting.group.length 
      && zone.now_playing?.one_line?.line1 === this.awaiting?.now_playing?.one_line?.line1){
      console.log("-> ",get_date(),"HEOS : FIXED     : GROUP INCOMPLETE - RE-GROUPING ",zone.display_name,this.awaiting?.sum_group, sum )
      services.svc_transport.group_outputs(this.awaiting.group)  
    }
  }
  if (this.is_leader() && zone.now_playing?.one_line?.line1 != this._zone?.now_playing?.one_line?.line1){
    if(zone?.now_playing?.one_line?.line1){
        this._player.awaiting = zone.now_playing
        console.log("-> ",get_date(),"RHEOS: PLAYING   :",zone.now_playing?.two_line?.line1.slice(0,200) ,"FROM POSITION",zone?.now_playing?.seek_position)
        services.svc_transport.control(this._zone,'stop')  
    } 
    if (zone.now_playing?.one_line && this._player?.udn){	
        const now_playing = zone.now_playing 
        const duration = ((zone?.now_playing?.length - zone?.now_playing?.seek_position > 0) 
        ?
        zone?.now_playing?.length - zone?.now_playing?.seek_position 
        : zone?.now_playing?.length) * 1000
        const position = (zone?.now_playing?.seek_position > 0 ? zone?.now_playing?.seek_position : 1) *1000 
        LOG && console.log("<- ",get_date(),"RHEOS: SET META  :",this._player.name.toUpperCase(),"♫",zone?.now_playing?.two_line?.line1.slice(0,100),duration,position)
        fs.writeFile(
        "./UPnP/"+this._player.udn,
        (this._player.mode == "FLOW" || this._player.mode == "ALBUM" ? "Streaming from RHEOS" : now_playing?.three_line?.line1) + "\n" 
        + (this._player.mode == "FLOW" ? "FLOW MODE ON" : (now_playing?.three_line?.line2 )) + "\n" 
        + ((this._player.mode == "FLOW" || this._player.mode == "ALBUM") ?  (rheos_zones.get(this._player.pid)?.name || this._player.name) : ("RHEOS: " +  now_playing?.three_line?.line3))   + "\n"
        + duration.toString() + "\n" 
        + position.toString() + "\n" 
        + (this._player.mode == "ART" || this._player.mode == "ALBUM"  ? (now_playing?.image_key) : `http://${rheos.system_info[0]}:${image_server.address().port}/Images/${rheos.mysettings.logo}`), 
        {encoding: "utf8",	flag: "w",	mode: 0o666 }
      )	.catch(err => console.error(get_date(),"ERROR WRITING METADATA FILE FOR",this._player.name,err))
      if(this._zone.now_playing){setTimeout((zone)=>{
        console.log("<- ",get_date(),"RHEOS: ZONE      : UPDATED",zone.display_name);services.svc_transport.control(zone,'play')
      },1000,this._zone)}
    } 
  
  }
  this._zone = zone
  }       
  get zone() {
    return this._zone;
  }
  set output(output) {
  if (this._player){
      const{is_muted,value} = output.volume || {}
      if (this._player?.volume?.level !== value ){
        LOG && console.log("<- ",get_date(),"RHEOS:",this._volume ?"UPDATING  :" : "SETTING   :",this._player.name.toUpperCase(),"VOLUME",value, "FROM",(this._player.volume?.level || 0))	
        heos_command("player", "set_volume", { pid: this._player.pid, level: (value > 0 ? value  : 0 )},200,true).catch(err => console.error(get_date(),err))	
      }
      if (this._player?.volume?.state  !== (is_muted ? "on" : "off")){ 
        LOG && console.log("<- ",get_date(),"RHEOS:",this._volume ?"UPDATING  :" : "SETTING   :",this._player.name.toUpperCase(),"MUTE",(is_muted?"ON":"OFF"))
        heos_command("player", "set_mute", { pid: this._player.pid, state: is_muted ? "on": "off"},200,true).catch(err => console.error(get_date(),err))
      }
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
  return (!this._player.gid || this._player.pid == this._player.gid)
 }
}
export {Heos_player}