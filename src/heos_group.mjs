import {group_enqueue,get_group_outputs,get_zone_players} from "./heos_utils.mjs";
import {services} from "../app.mjs"
import {get_date} from "../src/utils.mjs"
class Heos_group{
    get group (){
        return this._group?.sum_group
    }  
    get gid(){
        return this._group?.gid
    }  	
    set group(group){
        this._group = group
        services.svc_transport.group_outputs(get_group_outputs(group), (err) => {
            if (err){
                console.error("-> ",get_date(),"RHEOS: ERROR    ⚠",err) 
            } 
        })  
    } 
    get zone (){
        return this._zone
    }
    get zone_id (){
        return this._zone?.zone_id
    }
    set zone (zone){  
        if (zone?.outputs?.length !== this._zone?.outputs?.length){     
            const group = get_zone_players(zone);
            this._zone = zone;
            group_enqueue(group.players,group.sum_group).catch((err)=>{console.error("-> ",get_date(),"RHEOS: ERROR    ⚠",err)}) 
        }
    }
}
export {Heos_group}