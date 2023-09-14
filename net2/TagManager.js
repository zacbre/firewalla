/*    Copyright 2020-2023 Firewalla Inc.
 *
 *    This program is free software: you can redistribute it and/or  modify
 *    it under the terms of the GNU Affero General Public License, version 3,
 *    as published by the Free Software Foundation.
 *
 *    This program is distributed in the hope that it will be useful,
 *    but WITHOUT ANY WARRANTY; without even the implied warranty of
 *    MERCHANTABILITY or FITNESS FOR A PARTICULAR PURPOSE.  See the
 *    GNU Affero General Public License for more details.
 *
 *    You should have received a copy of the GNU Affero General Public License
 *    along with this program.  If not, see <http://www.gnu.org/licenses/>.
 */

'use strict';

const _ = require('lodash');
const log = require('./logger.js')(__filename);
const rclient = require('../util/redis_manager.js').getRedisClient();
const f = require('./Firewalla.js');
const sem = require('../sensor/SensorEventManager.js').getInstance();
const sysManager = require('./SysManager.js');
const asyncNative = require('../util/asyncNative.js');
const Tag = require('./Tag.js');
const DNSMASQ = require('../extension/dnsmasq/dnsmasq.js');
const Constants = require('./Constants.js');
const dnsmasq = new DNSMASQ();

class TagManager {
  constructor() {
    const c = require('./MessageBus.js');
    this.subscriber = new c("info");
    this.tags = {};

    this.scheduleRefresh();

    if (f.isMain()) {
      sem.once('IPTABLES_READY', async () => {
        log.info("Iptable is ready, apply tag policies ...");
        this.scheduleRefresh();
      });
    }

    this.subscriber.subscribeOnce("DiscoveryEvent", "Tags:Updated", null, async (channel, type, id, obj) => {
      log.info(`Tags are updated`);
      this.scheduleRefresh();
    });

    return this;
  }

  scheduleRefresh() {
    if (this.refreshTask)
      clearTimeout(this.refreshTask);
    this.refreshTask = setTimeout(async () => {
      await this.refreshTags();
      if (f.isMain()) {
        if (sysManager.isIptablesReady()) {
          for (let uid in this.tags) {
            const tag = this.tags[uid];
            tag.scheduleApplyPolicy();
          }
        }
      }
    }, 1000);
  }

  async toJson() {
    const json = {};
    for (let uid in this.tags) {
      await this.tags[uid].loadPolicyAsync();
      json[uid] = this.tags[uid].toJson();
    }
    return json;
  }

  async _getNextTagUid() {
    let uid = await rclient.getAsync("tag:uid");
    if (!uid) {
      uid = 1;
      await rclient.setAsync("tag:uid", uid);
    }
    await rclient.incrAsync("tag:uid");
    return uid;
  }

  // This function should only be invoked in FireAPI. Please follow this rule!
  async createTag(name, obj) {
    if (!obj)
      obj = {};
    const type = obj.type || "group";
    const newUid = await this._getNextTagUid();
    for (let uid in this.tags) {
      if (this.tags[uid].o && this.tags[uid].o.name === name && this.tags[uid].o.type === type) {
        if (obj) {
          const tag = Object.assign({}, obj, {uid: uid, name: name});
          const keyPrefix = _.get(Constants.TAG_TYPE_MAP, [this.tags[uid].getTagType(), "redisKeyPrefix"]);
          const key = keyPrefix && `${keyPrefix}${uid}`;
          if (key) {
            await rclient.hmsetAsync(key, tag);
            this.subscriber.publish("DiscoveryEvent", "Tags:Updated", null, tag);
            await this.refreshTags();
          } else return null;
        }
        return this.tags[uid].toJson();
      }
    }
    // do not directly create tag in this.tags, only update redis tag entries
    // this.tags will be created from refreshTags() together with createEnv()
    
    const tag = Object.assign({}, obj, {uid: newUid, name: name});
    const keyPrefix = _.get(Constants.TAG_TYPE_MAP, [type, "redisKeyPrefix"]);
    const key = keyPrefix && `${keyPrefix}${newUid}`;
    if (key) {
      await rclient.hmsetAsync(key, tag);
      this.subscriber.publish("DiscoveryEvent", "Tags:Updated", null, tag);
      await this.refreshTags();
    } else return null;
    return this.tags[newUid].toJson();
  }

  // This function should only be invoked in FireAPI. Please follow this rule!
  async removeTag(uid) {
    uid = String(uid);
    if (_.has(this.tags, uid)) {
      const keyPrefix = _.get(Constants.TAG_TYPE_MAP, [this.tags[uid].getTagType(), "redisKeyPrefix"]);
      const key = keyPrefix && `${keyPrefix}${uid}`;
      key && await rclient.unlinkAsync(key);
      this.subscriber.publish("DiscoveryEvent", "Tags:Updated", null, this.tags[uid].o);
      await this.refreshTags();
      return;
    }
    log.warn(`Tag ${uid} does not exist, no need to remove it`);
  }

  async updateTag(uid, name, obj = {}) {
    uid = String(uid);
    const type = obj.type || "group";
    if (_.has(this.tags, uid)) {
      const tag = this.tags[uid];
      let changed = false;
      if (tag.getTagName() !== name) {
        tag.setTagName(name);
        changed = true;
      }
      // different type of tags are saved in different redis hash keys
      if (tag.o.type !== type) {
        const oldType = tag.o.type || "group";
        const oldPrefix = _.get(Constants.TAG_TYPE_MAP, [oldType, "redisKeyPrefix"]);
        if (oldPrefix) {
          const oldKey = `${oldPrefix}${uid}`;
          await rclient.unlinkAsync(oldKey);
        }
        changed = true;
      }
      if (type) {
        const keyPrefix = _.get(Constants.TAG_TYPE_MAP, [type, "redisKeyPrefix"]);
        if (keyPrefix) {
          const o = Object.assign({}, { uid, name }, tag.o, obj);
          const key = `${keyPrefix}${uid}`;
          await rclient.hmsetAsync(key, o);
          changed = true;          
        } else return null;
      }
      if (changed) {
        this.subscriber.publish("DiscoveryEvent", "Tags:Updated", null, tag);
        await this.refreshTags();
      }
      return this.tags[uid].toJson();
    }
    return null;
  }

  getTagByUid(uid) {
    return uid && this.tags[uid];
  }

  async tagUidExists(uid, type) {
    if (this.getTagByUid(uid))
      return true;
    for (const key of Object.keys(Constants.TAG_TYPE_GROUP)) {
      if (!type || type === key) {
        const redisKeyPrefix = _.get(Constants.TAG_TYPE_MAP, [key, "redisKeyPrefix"]);
        if (redisKeyPrefix) {
          const result = await rclient.typeAsync(`${redisKeyPrefix}${uid}`);
          if (result !== "none")
            return true;
        }
      }
    }
    return false;
  }

  async refreshTags() {
    const markMap = {};
    for (let uid in this.tags) {
      markMap[uid] = false;
    }

    const keyPrefixes = [];
    for (const type of Object.keys(Constants.TAG_TYPE_MAP)) {
      const config = Constants.TAG_TYPE_MAP[type];
      const redisKeyPrefix = config.redisKeyPrefix;
      keyPrefixes.push(redisKeyPrefix);
    }
    for (const keyPrefix of keyPrefixes) {
      const keys = await rclient.scanResults(`${keyPrefix}*`);
      for (let key of keys) {
        const o = await rclient.hgetallAsync(key);
        const uid = key.substring(keyPrefix.length);
        if (this.tags[uid]) {
          await this.tags[uid].update(o);
        } else {
          this.tags[uid] = new Tag(o);
          if (f.isMain()) {
            (async () => {
              await sysManager.waitTillIptablesReady()
              log.info(`Creating environment for tag ${uid} ${o.name} ...`);
              await this.tags[uid].createEnv();
            })()
          }
        }
        markMap[uid] = true;
      }
    }

    const removedTags = {};
    Object.keys(this.tags).filter(uid => markMap[uid] === false).map((uid) => {
      removedTags[uid] = this.tags[uid];
    });
    for (const uid in removedTags) {
      if (f.isMain()) {
        (async () => {
          await sysManager.waitTillIptablesReady()
          log.info(`Destroying environment for tag ${uid} ${removedTags[uid].name} ...`);
          await removedTags[uid].destroyEnv();
          await dnsmasq.writeAllocationOption(uid, {})
        })()
      }
      delete this.tags[uid];
    }
    return this.tags;
  }

  async loadPolicyRules() {
    await asyncNative.eachLimit(Object.values(this.tags), 10, id => id.loadPolicyAsync())
  }
}

const instance = new TagManager();
module.exports = instance;
