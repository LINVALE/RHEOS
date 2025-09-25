import express from 'express'
import {get_date} from './src/utils.mjs'

export const LOG_FILE_PATH = "./UPnP/Logs/";
export const PROFILE_PATH = "./UPnP/Profiles/";
export const TIMEOUT = 10000;
export const SHORTTIMEOUT = 5000;
export const heos_players = new Map();
export let LOG = process.argv.includes("-l")||process.argv.includes("-log")
//export const image_server = {};
const images = express('UPnP');
images.use(express.static("UPnP"))
export const image_server = images.listen(0, () => {
	console.log("<- ",get_date(),`RHEOS: LISTENING : PORT ${image_server.address().port}`)
});
// ...other config...