// SPDX-FileCopyrightText: GSConnect Developers https://github.com/GSConnect
//
// SPDX-License-Identifier: GPL-2.0-or-later

// -*- mode: js; -*-

import Gdk from 'gi://Gdk?version=3.0';
import 'gi://GdkPixbuf?version=2.0';
import Gio from 'gi://Gio?version=2.0';
import GLib from 'gi://GLib?version=2.0';
import GObject from 'gi://GObject?version=2.0';
import Gtk from 'gi://Gtk?version=3.0';

import system from 'system';

import './preferences/init.js';
import {Window} from './preferences/service.js';
import Config from './config.js';

import('gi://GioUnix?version=2.0').catch(() => {}); // Set version for optional dependency


/**
 * Class representing the GSConnect service daemon.
 */
const Preferences = GObject.registerClass({
    GTypeName: 'GSConnectPreferences',
    Implements: [Gio.ActionGroup],
}, class Preferences extends Gtk.Application {

    _init() {
        super._init({
            application_id: 'org.gnome.Shell.Extensions.GSConnect.Preferences',
            resource_base_path: '/org/gnome/Shell/Extensions/GSConnect',
        });

        GLib.set_prgname('gsconnect-preferences');
        GLib.set_application_name(_('GSConnect Preferences'));
    }

    vfunc_activate() {
        if (this._window === undefined) {
            this._window = new Window({
                application: this,
            });
        }

        this._window.present();
    }

    vfunc_startup() {
        super.vfunc_startup();

        // Init some resources
        const provider = new Gtk.CssProvider();
        provider.load_from_resource(`${Config.APP_PATH}/application.css`);
        Gtk.StyleContext.add_provider_for_screen(
            Gdk.Screen.get_default(),
            provider,
            Gtk.STYLE_PROVIDER_PRIORITY_APPLICATION
        );

        const actions = [
            ['refresh', null],
            ['connect', GLib.VariantType.new('s')],
        ];

        for (const [name, type] of actions) {
            const action = new Gio.SimpleAction({
                name: name,
                parameter_type: type,
            });
            this.add_action(action);
        }
    }

    vfunc_activate_action(action_name, parameter) {
        try {
            const paramArray = [];

            if (parameter instanceof GLib.Variant)
                paramArray[0] = parameter;

            this.get_dbus_connection().call(
                'org.gnome.Shell.Extensions.GSConnect',
                '/org/gnome/Shell/Extensions/GSConnect',
                'org.freedesktop.Application',
                'ActivateAction',
                GLib.Variant.new('(sava{sv})', [action_name, paramArray, {}]),
                null,
                Gio.DBusCallFlags.NONE,
                -1,
                null,
                null
            );
        } catch (e) {
            logError(e);
        }
    }
});

await (new Preferences()).runAsync([system.programInvocationName].concat(ARGV));
