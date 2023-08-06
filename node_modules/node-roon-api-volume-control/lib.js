"use strict";

function RoonApiVolumeControl(roon, opts) {
    this._objs = {};

    this._svc = roon.register_service("com.roonlabs.volumecontrol:1", {
        subscriptions: [
            {
                subscribe_name:   "subscribe_controls",
                unsubscribe_name: "unsubscribe_controls",
                start: (req) => {
                    req.send_continue("Subscribed", { controls: Object.values(this._objs).reduce((p,e) => p.push(e.state) && p, []) });
                }
            }
        ],
        methods: {
            get_all: (req) => {
                req.send_complete("Success", { controls: Object.values(this._objs).reduce((p,e) => p.push(e.state) && p, []) });
            },
            set_volume: (req) => {
                var d = this._objs[req.body.control_key];
                d.set_volume(req, req.body.mode, req.body.value);
            },
            set_mute: (req) => {
                var d = this._objs[req.body.control_key];
                d.set_mute(req, req.body.mode);
            }
        }
    });

    this.services = [ this._svc ];
}

RoonApiVolumeControl.prototype.new_device = function(o) {
    o.state.control_key = o.state.control_key || "1";

    if (this._objs[o.state.control_key])
        throw new Error('Must set control key to unique id');

    this._objs[o.state.control_key] = o;
    this._svc.send_continue_all('subscribe_controls', "Changed", { controls_added: [ o.state ] });
    return {
        destroy: () => {
            this._svc.send_continue_all('subscribe_controls', "Changed", { controls_removed: [ o.state.control_key ] });
            delete(this._objs[o.state.control_key]);
        },
        update_state: (state) => {
            for (let x in state) if (o.state[x] !== state[x]) o.state[x] = state[x];
            this._svc.send_continue_all('subscribe_controls', "Changed", { controls_changed: [ o.state ] });
        }
    };
};

exports = module.exports = RoonApiVolumeControl;
