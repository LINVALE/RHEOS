import {unhide_value, get_date} from "./utils.mjs";
import {group_enqueue} from "./heos_utils.mjs";
import { Heos_player } from "./heos_player.mjs";
import {heos_players} from "../config.js"
class Fixed_group {

constructor(group){
    this._group = group;
     console.log("SETTING FIXED GROUP",group)
}
set output(op){
    this._output = op
   
    this._zone = op.zone
} 
get zone (){

return this._zone
}
get group(){
    return this._group
}
get gid (){
    return this._group.gid
}
get sum_group (){
    return this._group.sum_group
}
get name(){
    return this._group.name
}
get output(){
    return this._controller
}
get lead(){
    return(heos_players.get((this._group.players).find(p => p.role == 'leader').pid))
}
get group(){
    if (this._group.players){
        return (this._group.players.map((p)=>{return (heos_players.get(p.pid)).output}).push(this._controller))
    } else {  
              return []
    }
    
}
get players(){
   // return this._group.players.map((p)=>{return (heos_players.get(p.pid))})
      if (this._group.players){
        return (this._group.players.map((p)=> (heos_players.get(p.pid))))
    } else {  
              return []
    }
}
get outputs(){
    return this._group.players.map((p)=>{return (heos_players.get(p.pid))?.output})
}
set transferring(s){
    this._group.transferring = s
}
get transferring(){
    return this._group.transferring

}
set waiting(s){
    this._group.waiting = s
}
get waiting(){
    return this._group.waiting

}
}
export {Fixed_group}