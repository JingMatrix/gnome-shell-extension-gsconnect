"use strict";

const Lang = imports.lang;
const Gettext = imports.gettext.domain("gsconnect");
const _ = Gettext.gettext;

const Gdk = imports.gi.Gdk;
const GdkPixbuf = imports.gi.GdkPixbuf;
const Gio = imports.gi.Gio;
const GLib = imports.gi.GLib;
const GObject = imports.gi.GObject;
const Gtk = imports.gi.Gtk;
const Pango = imports.gi.Pango;

// Local Imports
function getPath() {
    // Diced from: https://github.com/optimisme/gjs-examples/
    let m = new RegExp("@(.+):\\d+").exec((new Error()).stack.split("\n")[1]);
    return Gio.File.new_for_path(m[1]).get_parent().get_parent().get_path();
}

imports.searchPath.push(getPath());

const Common = imports.common;


/**
 * Phone Number types that support receiving texts
 */
const SUPPORTED_NUMBER_TYPES = [
    // GData: https://developers.google.com/gdata/docs/2.0/elements#rel-values_71
    "http://schemas.google.com/g/2005#home",
    "http://schemas.google.com/g/2005#main",
    "http://schemas.google.com/g/2005#mobile",
    "http://schemas.google.com/g/2005#other",
    "http://schemas.google.com/g/2005#pager",
    "http://schemas.google.com/g/2005#work",
    "http://schemas.google.com/g/2005#work_mobile",
    "http://schemas.google.com/g/2005#work_pager",
    // Folks: http://www.ietf.org/rfc/rfc2426.txt
    "home",
    "cell",     // Equal to GData->mobile
    "pager",
    "pref",     // Equal to GData->main
    "work",
    "voice"     // Sometimes mapped from GData#work
];

/**
 * SMS Message direction
 */
var MessageDirection = {
    OUT: 0,
    IN: 1
};


/**
 * Message Bubble Colours
 * See: https://developer.gnome.org/hig/stable/icons-and-artwork.html
 *      http://tango.freedesktop.org/Tango_Icon_Theme_Guidelines#Color_Palette
 *      http://leaverou.github.io/contrast-ratio/
 */
var MessageStyle = new Gtk.CssProvider();
// TODO: MessageStyle.load_from_resource("/style/sms.css");
MessageStyle.load_from_data(
    ".contact-avatar { border-radius: 16px; } " +
    ".message-bubble { border-radius: 1em; } " +
    
    ".contact-color-red { color: #ffffff; background-color: #cc0000; } " +
    ".contact-color-orange { color: #000000; background-color: #f57900; } " +
    ".contact-color-yellow { color: #000000; background-color: #edd440; } " +
    ".contact-color-green { color: #ffffff; background-color: #4e9a06; } " +
    ".contact-color-blue { color: #ffffff; background-color: #204a87; } " +
    ".contact-color-purple { color: #ffffff; background-color: #5c3566; } " +
    ".contact-color-brown { color: #ffffff; background-color: #8f5902; } " +
    ".contact-color-grey { color: #ffffff; background-color: #2e3436; } " +
    ".contact-color-outgoing { color: #000000; background-color: #d3d7cf; } "
);


var shuffleColor = Array.shuffler([
    "contact-color-red",
    "contact-color-orange",
    "contact-color-yellow",
    "contact-color-green",
    "contact-color-blue",
    "contact-color-purple",
    "contact-color-brown",
    "contact-color-grey"
]);

var LINK_REGEX = /\b((?:https?:\/\/|www\d{0,3}[.]|[a-z0-9.\-]+[.][a-z]{2,4}\/)(?:[^\s()<>]+|\(([^\s()<>]+|(\([^\s()<>]+\)))*\))+(?:\(([^\s()<>]+|(\([^\s()<>]+\)))*\)|[^\s`!()\[\]{};:'".,<>?«»“”‘’]))/gi;


/**
 * Contact Avatar
 */
var ContactAvatar = new Lang.Class({
    Name: "GSConnectContactAvatar",
    Extends: Gtk.DrawingArea,
    
    _init: function (params) {
        params = Object.assign({
            path: null,
            size: 32
        }, params);
        
        this.parent({
            height_request: params.size,
            width_request: params.size
        });

        this.loader = new GdkPixbuf.PixbufLoader();
        
        if (params.path) {
            this.loader.write(GLib.file_get_contents(params.path)[1]);
        }
        
        // Consider errors at this point to be warnings
        try {
            this.loader.close();
        } catch (e) {
            Common.debug("Warning: " + e.message);
        }
        
        let pixbuf = this.loader.get_pixbuf().scale_simple(
            params.size,
            params.size,
            GdkPixbuf.InterpType.HYPER
        );
        
        let surface = Gdk.cairo_surface_create_from_pixbuf(
            pixbuf,
            0,
            this.get_window()
        );
        
        this.connect("draw", (widget, cr) => {
            cr.setSourceSurface(surface, 0, 0);
            cr.arc(params.size/2, params.size/2, params.size/2, 0, 2*Math.PI);
            cr.clip();
            cr.paint();
            cr.$dispose();
            return false;
        });
    }
});

    
function getAvatar (recipient) {
    let avatar;
    
    if (recipient.avatar) {
        try {
            avatar = new ContactAvatar({ path: recipient.avatar });
        } catch (e) {
            Common.debug("Error creating avatar: " + e);
            avatar = getDefaultAvatar(recipient);
        }
    } else {
        avatar = getDefaultAvatar(recipient);
    }
    
    return avatar;
};


function getDefaultAvatar (recipient) {
    let avatar = new Gtk.Box({ width_request: 32, height_request: 32 });
    let avatarStyle = avatar.get_style_context();
    avatarStyle.add_provider(MessageStyle, 0);
    avatarStyle.add_class("contact-avatar");
    avatarStyle.add_class(recipient.color || shuffleColor());
    
    let defaultAvatar = new Gtk.Image({
        icon_name: "avatar-default-symbolic",
        pixel_size: 24,
        margin: 4,
        visible: true
    });
    avatar.add(defaultAvatar);
    
    return avatar;
};


var ContactList = new Lang.Class({
    Name: "GSConnectContactList",
    Extends: Gtk.ScrolledWindow,
    Properties: {
        "recipients": GObject.param_spec_variant(
            "recipients",
            "RecipientList", 
            "A list of target recipient phone numbers",
            new GLib.VariantType("as"),
            new GLib.Variant("as", []),
            GObject.ParamFlags.READABLE
        )
    },
    
    _init: function (params) {
        this.parent({
            can_focus: false,
            hexpand: true,
            vexpand: true,
            hscrollbar_policy: Gtk.PolicyType.NEVER,
            shadow_type: Gtk.ShadowType.IN
        });
        
        this._parent = params.parent;
        this.contacts = params.contacts;
        //this.cache.connect("notify::contacts", () => { this._populate(); });
        
        this.entry = params.entry;
        this.entry.connect("changed", () => { this._changed(); });
        
        // ListBox
        this.list = new Gtk.ListBox({ selection_mode: Gtk.SelectionMode.NONE });
        this.list.set_filter_func(Lang.bind(this, this._filter));
        this.list.set_sort_func(Lang.bind(this, this._sort));
        this.add(this.list);
        
        // Placeholder
        let box = new Gtk.Box({
            orientation: Gtk.Orientation.VERTICAL,
            visible: true,
            hexpand: true,
            halign: Gtk.Align.CENTER,
            vexpand: true,
            valign: Gtk.Align.CENTER,
            margin: 12,
            spacing: 12
        });
        
        let placeholderImage = new Gtk.Image({
            icon_name: "avatar-default-symbolic",
            pixel_size: 48,
            visible: true
        });
        placeholderImage.get_style_context().add_class("dim-label");
        box.add(placeholderImage);
        
        let placeholderLabel = new Gtk.Label({
            label: "<b>" + _("Add people to start a conversation") + "</b>",
            visible: true,
            use_markup: true,
            wrap: true,
            justify: Gtk.Justification.CENTER
        });
        placeholderLabel.get_style_context().add_class("dim-label");
        
        box.add(placeholderLabel);
        this.list.set_placeholder(box);
        
        // Populate and setup
        this._populate();
        this.show_all();
        this.entry.has_focus = true;
        this.list.unselect_all();
    },
    
    get recipients () {
        let recipients = [];
        
        this.list.foreach((row) => {
            if (row.recipient.active) {
                recipients.push(row.contact.number);
            }
        });
        
        return recipients;
    },
    
    _add: function (contact) {
        let row = new Gtk.ListBoxRow();
        row.contact = contact;
        
        let grid = new Gtk.Grid({
            margin: 6,
            column_spacing: 6
        });
        row.add(grid);
        
        grid.attach(getAvatar(contact), 0, 0, 1, 2);
        
        row._name = new Gtk.Label({
            label: contact.name || _("Unknown Contact"),
            halign: Gtk.Align.START,
            hexpand: true
        });
        grid.attach(row._name, 1, 0, 1, 1);
        
        row._number = new Gtk.Label({
            label: contact.number || _("Unknown Number"),
            halign: Gtk.Align.START,
            hexpand: true
        });
        row._number.get_style_context().add_class("dim-label");
        grid.attach(row._number, 1, 1, 1, 1);
        
        //
        row._type = new Gtk.Image({
            icon_name: "phone-number-default",
            pixel_size: 16
        });
        
        if (!contact.type) {
            row._type.icon_name = "phone-number-default";
        } else if (contact.type.indexOf("home") > -1) {
            row._type.icon_name = "phone-number-home";
        } else if (contact.type.indexOf("cell") > -1 || contact.type.indexOf("mobile") > -1) {
            row._type.icon_name = "phone-number-mobile";
        } else if (contact.type.indexOf("work") > -1 || contact.type.indexOf("voice") > -1) {
            row._type.icon_name = "phone-number-work";
        }
        grid.attach(row._type, 2, 0, 1, 2);
        
        row.recipient = new Gtk.CheckButton({
            active: false,
            margin_right: 12
        });
        row.recipient.connect("toggled", () => { this._toggle(row); });
        grid.attach(row.recipient, 3, 0, 1, 2);
        
        row.show_all();
        
        this.list.add(row);
        
        return row;
    },
    
    _changed: function (entry) {
        if (this.entry.text.replace(/\D/g, "").length > 2) {
            if (this._dynamic) {
                this._dynamic._name.label = _("Send to %d").format(this.entry.text);
                this._dynamic._number.label = this.entry.text;
                this._dynamic.contact.number = this.entry.text;
            } else {
                this._dynamic = this._add({
                    name: _("Send to %d").format(this.entry.text),
                    number: this.entry.text,
                    dynamic: true
                });
                this._dynamic.contact.name = _("Unknown Contact");
            }
        } else if (this._dynamic) {
            this._dynamic.destroy();
            delete this._dynamic;
        }
        
        this.list.invalidate_sort();
        this.list.invalidate_filter();
    },
    
    _filter: function (row) {
        if (!this.entry) { return true; }
        
        let name = row.contact.name.toLowerCase();
        let number = row.contact.number.replace(/\D/g, "");
        let filterNumber = this.entry.text.replace(/\D/g, "");
        
        if (row.contact.dynamic) {
            return true;
        } else if (name.indexOf(this.entry.text) > -1) {
            return true;
        } else if (filterNumber.length && number.indexOf(filterNumber) > -1) {
            return true;
        }
        
        return false;
    },
    
    _populate: function () {
        this.list.foreach((child) => { child.destroy(); });
        
        for (let contact of this.contacts) {
            this._add(contact);
        }
    },
    
    _sort: function (row1, row2) {
        if (row1.contact.dynamic) {
            return -1;
        } else if (row2.contact.dynamic) {
            return 1;
        } else if (row1.recipient.active && !row2.recipient.active) {
            return -1;
        } else if (!row1.recipient.active && row2.recipient.active) {
            return 1;
        }
        
        return row1.contact.name.localeCompare(row2.contact.name);
    },
    
    _toggle: function (row) {
        if (row.recipient.active) {
            if (row.contact.dynamic) {
                row._name.label = row.contact.name;
                delete this._dynamic;
            }
            this._parent.addRecipient(row.contact);
        } else {
            this._parent.removeRecipient(row.contact);
            if (row.contact.dynamic) {
                row.destroy();
            }
        }
        
        this.entry.text = "";
        this.list.invalidate_sort();
        this.notify("recipients");
    }
});


var MessageView = new Lang.Class({
    Name: "GSConnectMessageView",
    Extends: Gtk.Box,
    
    _init: function (window) {
        this.parent({
            orientation: Gtk.Orientation.VERTICAL,
            margin: 6,
            spacing: 6
        });
        
        this._parent = window;
        
        // Messages List
        let frame = new Gtk.Frame();
        this.add(frame);
        
        this.threadWindow = new Gtk.ScrolledWindow({
            can_focus: false,
            hexpand: true,
            vexpand: true,
            hscrollbar_policy: Gtk.PolicyType.NEVER
        });
        frame.add(this.threadWindow);
        
        this.list = new Gtk.ListBox({
            visible: true,
            halign: Gtk.Align.FILL
        });
        this.list.connect("size-allocate", (widget) => {
            let vadj = this.threadWindow.get_vadjustment();
            vadj.set_value(vadj.get_upper() - vadj.get_page_size());
        });
        this.threadWindow.add(this.list);
        
        // Message Entry
        this.entry = new Gtk.Entry({
            hexpand: true,
            placeholder_text: _("Type an SMS message"),
            secondary_icon_name: "sms-send",
            secondary_icon_activatable: true,
            secondary_icon_sensitive: false
        });
        
        this.entry.connect("changed", (entry, signal_id, data) => {
            entry.secondary_icon_sensitive = (entry.text.length);
        });
        
        this.entry.connect("activate", (entry, signal_id, data) => {
            this._parent.send(entry, signal_id, data);
        });
        
        this.entry.connect("icon-release", (entry, signal_id, data) => {
            this._parent.send(entry, signal_id, data);
        });
        
        this._parent.device.bind_property(
            "connected",
            this.entry,
            "sensitive",
            GObject.BindingFlags.DEFAULT
        );
        this.add(this.entry);
    },
    
    /**
     * Add a new thread, which is a series of sequential messages from one user
     * with a single instance of the sender's avatar.
     *
     * @param {object} recipient - The recipient object
     * @param {MessageDirection} - The direction of the message; one of the
     *     MessageDirection enums (either OUT [0] or IN [1])
     * @return {Gtk.ListBoxRow} - The new thread
     */
    addThread: function (recipient, direction) {
        let row = new Gtk.ListBoxRow({
            activatable: false,
            selectable: false,
            hexpand: true,
            halign: Gtk.Align.FILL,
            visible: true,
            margin: 6
        });
        this.list.add(row);
        
        row.layout = new Gtk.Box({
            visible: true,
            can_focus: false,
            hexpand: true,
            spacing: 3,
            halign: (direction) ? Gtk.Align.START : Gtk.Align.END
        });
        row.add(row.layout);
        
        // Contact Avatar
        row.avatar = getAvatar(recipient);
        row.avatar.tooltip_text = recipient.name || recipient.number;
        row.avatar.valign = Gtk.Align.END;
        row.avatar.visible = direction;
        row.layout.add(row.avatar);
        
        // Messages
        row.messages = new Gtk.Box({
            visible: true,
            can_focus: false,
            orientation: Gtk.Orientation.VERTICAL,
            spacing: 3,
            halign: (direction) ? Gtk.Align.START : Gtk.Align.END,
            margin_right: (direction) ? 38 : 0,
            margin_left: (direction) ? 0: 38
        });
        row.layout.add(row.messages);
        
        return row;
    },
    
    /**
     * Add a new message, calling addThread() if necessary to create a new
     * thread.
     *
     * @param {string} recipient - The recipient object
     * @param {string} messageBody - The message content
     * @param {MessageDirection} - The direction of the message; one of the
     *     MessageDirection enums (either OUT [0] or IN [1])
     * @return {Gtk.ListBoxRow} - The new thread
     */
    addMessage: function (recipient, messageBody, direction) {
        let sender = recipient.name || recipient.number;
        let nrows = this.list.get_children().length;
        let row, currentThread;
        
        if (nrows) {
            let currentThread = this.list.get_row_at_index(nrows - 1);
            
            if (currentThread.avatar.tooltip_text === sender) {
                row = currentThread;
            }
        }
        
        if (!row) {
            row = this.addThread(recipient, direction);
        }
        
        let messageBubble = new Gtk.Grid({
            visible: true,
            halign: (direction) ? Gtk.Align.START : Gtk.Align.END
        });
        let messageBubbleStyle = messageBubble.get_style_context();
        messageBubbleStyle.add_provider(MessageStyle, 0);
        messageBubbleStyle.add_class("message-bubble");
        messageBubbleStyle.add_class((direction) ? recipient.color : "contact-color-outgoing");
        row.messages.add(messageBubble);
        
        let messageContent = new Gtk.Label({
            label: messageBody.replace(LINK_REGEX, '<a href="$1">$1</a>'),
            margin_top: 6,
            margin_bottom: 6,
            margin_right: 12,
            margin_left: 12,
            selectable: true,
            use_markup: true,
            visible: true,
            wrap: true,
            wrap_mode: Pango.WrapMode.WORD_CHAR,
            xalign: (direction) ? 0 : 1
        });
        messageContent.connect("activate-link", (label, uri) => {
            Gtk.show_uri_on_window(
                this.get_toplevel(),
                (uri.indexOf("://") < 0) ? "http://" + uri : uri,
                Gdk.CURRENT_TIME
            );
            return true;
        });
        messageBubble.add(messageContent);
    }
});


/**
 * A Gtk.ApplicationWindow for SMS conversations
 */
var ConversationWindow = new Lang.Class({
    Name: "GSConnectConversationWindow",
    Extends: Gtk.ApplicationWindow,
    Properties: {
        "recipients": GObject.param_spec_variant(
            "recipients",
            "RecipientList", 
            "A list of target recipient phone numbers",
            new GLib.VariantType("as"),
            new GLib.Variant("as", []),
            GObject.ParamFlags.READABLE
        )
    },
    
    _init: function(application, device) {
        this.parent({
            application: application,
            title: _("SMS Conversation"),
            default_width: 300,
            default_height: 300,
            icon_name: "phone"
        });
        
        this.device = device;
        this._recipients = new Map();
        this._notifications = [];
        
        // Header Bar
        this.headerBar = new Gtk.HeaderBar({ show_close_button: true });
        this.connect("notify::recipients", () => { this._setHeaderBar(); });
        this.set_titlebar(this.headerBar);
        
        // Contact Button
        this.contactButton = new Gtk.Button({
            image: new Gtk.Image({
                icon_name: "contact-new-symbolic",
                pixel_size: 16
            }),
            always_show_image: true,
            // TRANSLATORS: Tooltip for a button to add/remove people from a conversation
            tooltip_text: _("Add and remove people")
        });
        this.contactButton.connect("clicked", () => { this._showContacts(); });
        this.device.bind_property(
            "connected",
            this.contactButton,
            "sensitive",
            GObject.BindingFlags.DEFAULT
        );
        this.headerBar.pack_start(this.contactButton);
        
        // Messages Button
        this.messagesButton = new Gtk.Button({
            image: new Gtk.Image({
                icon_name: "go-previous-symbolic",
                pixel_size: 16
            }),
            always_show_image: true
        });
        this.messagesButton.connect("clicked", () => {
            this.contactEntry.text = "";
            this._showMessages();
        });
        this.device.bind_property(
            "connected",
            this.messagesButton,
            "sensitive",
            GObject.BindingFlags.DEFAULT
        );
        this.headerBar.pack_start(this.messagesButton);
        
        // Contact Entry // TODO: separate
        this.contactEntry = new Gtk.Entry({
            hexpand: true,
            placeholder_text: _("Type a phone number or name"),
            tooltip_text: _("Type a phone number or name"),
            primary_icon_name: "call-start-symbolic",
            primary_icon_activatable: false,
            primary_icon_sensitive: true,
            input_purpose: Gtk.InputPurpose.PHONE
        });
        this.device._plugins.get("telephony")._cache.bind_property(
            "provider",
            this.contactEntry,
            "primary-icon-name",
            GObject.BindingFlags.SYNC_CREATE
        );
        this.device.bind_property(
            "connected",
            this.contactEntry,
            "sensitive",
            GObject.BindingFlags.DEFAULT
        );
        this.headerBar.custom_title = this.contactEntry;
        
        // Content Layout
        this.layout = new Gtk.Grid();
        this.add(this.layout);
        
        // InfoBar
        this.infoBar = new Gtk.InfoBar({
            message_type: Gtk.MessageType.WARNING
        });
        this.infoBar.get_content_area().add(
            new Gtk.Image({ icon_name: "dialog-warning-symbolic" })
        );
        this.infoBar.get_content_area().add(
            new Gtk.Label({
                // TRANSLATORS: eg. <b>Google Pixel</b> is disconnected
                label: _("<b>%s</b> is disconnected").format(this.device.name),
                use_markup: true
            })
        );
        // See: https://bugzilla.gnome.org/show_bug.cgi?id=710888
        this.device.connect("notify::connected", () => {
            if (!this.device.connected) {
                this.layout.attach(this.infoBar, 0, 0, 1, 1);
                this.infoBar.show_all();
            } else if (this.device.connected) {
                this.infoBar.hide();
                this.layout.remove(this.infoBar);
            }
        });

        // Conversation Stack (Recipients/Threads)
        this.stack = new Gtk.Stack({
            transition_type: Gtk.StackTransitionType.SLIDE_UP_DOWN,
            halign: Gtk.Align.FILL,
            valign: Gtk.Align.FILL,
            hexpand: true,
            vexpand: true
        });
        this.device.bind_property(
            "connected",
            this.stack,
            "sensitive",
            GObject.BindingFlags.DEFAULT
        );
        this.layout.attach(this.stack, 0, 1, 1, 1);
        
        // Contact List
        this.contactList = new ContactList({
            parent: this,
            contacts: this.device._plugins.get("telephony")._cache.contacts,
            entry: this.contactEntry
        });
        this.contactList.connect("notify::recipients", () => {
            this._setHeaderBar();
        });
        this.stack.add_named(this.contactList, "contacts");
        
        // MessageView
        this.messageView = new MessageView(this);
        this.stack.add_named(this.messageView, "messages");
        
        // Clear pending notifications on focus
        this.messageView.entry.connect("notify::has-focus", () => {
            while (this._notifications.length) {
                this.application.withdraw_notification(
                    this._notifications.pop()
                );  
            }
        });
        
        // Finish initing
        this.show_all();
        this.notify("recipients");
    },
    
    _setHeaderBar: function () {
        if (this._recipients.size) {
            let firstRecipient = this._recipients.values().next().value;
            
            if (firstRecipient.name) {
                this.headerBar.set_title(firstRecipient.name);
                this.headerBar.set_subtitle(firstRecipient.number);
            } else {
                this.headerBar.set_title(firstRecipient.number);
                this.headerBar.set_subtitle(null);
            }
            
            if (this._recipients.size > 1) {
                let num = this._recipients.size - 1;
                
                this.headerBar.set_subtitle(
                    Gettext.ngettext(
                        "And one other person",
                        "And %d other people",
                        num
                    ).format(num)
                );
            }
                
            let people = [];
            
            for (let recipient of this._recipients.values()) {
                if (recipient.name) {
                    people.push(recipient.name);
                } else {
                    people.push(recipient.number);
                }
            }
            
            this.headerBar.set_tooltip_text(
                // TRANSLATORS: eg. SMS Conversation with John, Paul, George, Ringo
                _("SMS Conversation with %s").format(people.join(", "))
            );
            
            this._showMessages();
        } else {
            this.headerBar.set_title(_("New SMS Conversation"));
            this.headerBar.set_subtitle(null);
            this.headerBar.set_tooltip_text("");
            this._showContacts();
        }
    },
    
    _showContacts: function () {
        this.headerBar.custom_title = this.contactEntry;
        this.contactEntry.has_focus = true;
        
        this.messagesButton.visible = (this._recipients.size);
        this.contactButton.visible = false;
        this.stack.set_visible_child_name("contacts");
    },
    
    _showMessages: function () {
        this.headerBar.custom_title = null;
        
        this.messagesButton.visible = false;
        this.contactButton.visible = true;
        this.messageView.entry.has_focus = true;
        this.stack.set_visible_child_name("messages");
    },
    
    get recipients () {
        return Array.from(this._recipients.keys());
    },
    
    /**
     * Add a contact to the list of recipients
     *
     * @param {object} contact - An object in the form of ContactsCache contacts
     * @return {object} - The recipient object
     */
    addRecipient: function (contact) {
        let plugin = this.device._plugins.get("telephony");
        let strippedNumber = contact.number.replace(/\D/g, "");
        
        // Get data from the cache
        let recipient = Object.assign(
            contact,
            plugin._cache.getContact(strippedNumber, contact.name || "")
        );
        
        // This is an extant recipient
        if (this._recipients.has(strippedNumber)) {
            recipient = Object.assign(
                this._recipients.get(strippedNumber),
                recipient
            );
            
            this._recipients.set(strippedNumber, recipient);
        // This is a new recipient
        } else {
            recipient.color = shuffleColor(); // Only do this once per recipient
            this._recipients.set(strippedNumber, recipient);
            
            // TODO: cleanup
            let found = false;
            this.contactList.list.foreach((row) => {
                if (row.contact.name === recipient.name &&
                    row.contact.number.replace(/\D/g, "") === strippedNumber) {
                    row.recipient.active = true;
                    found = true;
                }
            });
            
            if (!found) {
                this.contactList._add(recipient);
            }
        }
        
        this.notify("recipients");
        return recipient;
    },
    
    /** Remove a contact by phone number from the list of recipients */
    removeRecipient: function (recipient) {
        let strippedNumber = recipient.number.replace(/\D/g, "");
        
        if (this._recipients.has(strippedNumber)) {
            this._recipients.delete(strippedNumber);
            this.notify("recipients");
        }
    },
    
    /** Log an incoming message in the MessageList */
    receive: function (phoneNumber, contactName, messageBody) {
        let recipient = this.addRecipient({
            number: phoneNumber,
            name: contactName
        });
    
        this.messageView.addMessage(
            recipient,
            messageBody,
            MessageDirection.IN
        );
    },
    
    /** Send the contents of MessageView.entry to each recipient */
    send: function (entry, signal_id, event) {
        let plugin = this.device._plugins.get("telephony");
        
        // Send to each number
        for (let number of this.recipients) {
            plugin.sendSms(number, entry.text);
        }
        
        // Log the outgoing message
        this.messageView.addMessage(
            { number: "0", color: "contact-color-grey" },
            entry.text,
            MessageDirection.OUT
        );
        entry.text = "";
    }
});

