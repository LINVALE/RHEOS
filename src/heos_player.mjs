
import {unhide_value, get_date} from "./utils.mjs";
import {group_enqueue} from "./heos_utils.mjs";
import { rheos_outputs } from "../app.mjs";
//import {LOG,TIMEOUT,SHORTTIMEOUT,heos_players} from '../config.js'
class Heos_player{
  constructor(player) {
    this._player = player; 
    this._zone = null;
    this._sum_group = player.pid;
    this._output = null;
    this._player.volume = {level: player?.volume || 0, state: player?.is_muted ? "on" : "off"}; 
    this._player.now_playing = null;
    this._player.position = 0;
    this._player.duration = 0;
    this._player.state = "stopped"; // Possible states: playing, paused, stopped
    this._player.status = "idle"; // Possible statuses: idle, buffering, playing, paused
    this._player.group = null; // Group ID if the player is part of a group
    this._player.force_play = false; // Flag to force play even if already playing
    this._player.next = null; // Next track information
    this._player.payload = {}; // Additional payload data
  }
  static say_hello(res) {
    console.log('Hello from rheos_zone class!',res);
  }
  static is_leader(){
    Boolean(this.pid == this.gid || !this.gid)
  }
  set player(player) {
    this._player = player;
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
    return this._player.id
  }
  get name (){
    return this._player.name
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
    return this._player.now_playing
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
  get payload (){
    return this._player.payload
  } 
  set zone(zone) {
  //if(zone?.zone_id !== this._zone?.zone_id){
     
   //
    if (zone.outputs){
      const sum = zone.outputs.reduce((acc, op) => acc + (unhide_value(op.source_controls[0].display_name) || 0), 0)
      if (sum !== this._sum_group){
        this._sum_group = sum
        console.log("-> ",get_date(),"HEOS : ZONE      : GROUP HAS CHANGED FOR PLAYER",this._player.name,"TO",this._sum_group)
        let group = zone.outputs.map(op => unhide_value(op.source_controls[0].display_name))
        group_enqueue(group,sum).catch(()=>{console.log("ALREADY GROUPED",group)})
      }
      if(zone?.state !== this._zone?.state){
        
        console.log("-> ",get_date(),"HEOS : ZONE      : STATE HAS CHANGED FOR ZONE",this._player.name,"TO",zone.state,"FROM",this._zone?.state, "PLAYER STATE IS",this._player.state)
       //his.zone.state = zone.state
      }

      this._zone = zone;
    }
  
    
  }
  get zone() {
    return this._zone;
  }
  set output(output) {
    this._output = output;
  }
  get output() {
    if (this._output){
      return this._output
    } else {
      this._output = Array.from(rheos_outputs.values(0)).find(o => o.output_id == this._output?.output_id || unhide_value(o.source_controls[0].display_name)== this._pid)
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
 
  print() {
    console.log('PLAYER is: ' + this.player);
    console.log('PLAYER NAME is: ' + this.player.name);
    console.log('PLAYER VOLUME is: ' + this.volume);
    if (this.zone) {    
      console.log('Player is in zone with ID: ' + this.zone);
    } else {
      console.log('Player is not currently in a zone.');
    }
    if (this.player.now_playing) {
      console.log('Now playing: ' + (this.zone.now_playing.one_line ? this.player.now_playing.one_line.line1 : 'No information available'));
    } else {
      console.log('No media is currently playing.');
    }
  }
}
export {Heos_player}