/**
 * Copyright 2017, Google, Inc.
 * Licensed under the Apache License, Version 2.0 (the "License");
 * you may not use this file except in compliance with the License.
 * You may obtain a copy of the License at
 *
 *    http://www.apache.org/licenses/LICENSE-2.0
 *
 * Unless required by applicable law or agreed to in writing, software
 * distributed under the License is distributed on an "AS IS" BASIS,
 * WITHOUT WARRANTIES OR CONDITIONS OF ANY KIND, either express or implied.
 * See the License for the specific language governing permissions and
 * limitations under the License.
 */

const Telegraf = require('telegraf')
const Extra = require('telegraf/extra')
const Markup = require('telegraf/markup')

const HTMLParser = require('node-html-parser')
const rp = require('request-promise');
const queryString = require("query-string")

var CronJob = require('cron').CronJob;


// Imports the Google Cloud client library
const Datastore = require('@google-cloud/datastore')

// Load the config file
require('dotenv').config()

// Creates a client
const datastore = new Datastore({
  projectId: process.env.GCP_PROJECT_ID
});

const domain = 'http://steepandcheap.com'
const bot = new Telegraf(process.env.TG_BOT_TOKEN)
const tgGroupId = process.env.TG_GROUP_ID

function update_url(keyUrl, crawlUrl) {
  function update_db(productDom, keyUrl) {
    var tasks = []
    var currentTime = new Date()
    productDom.forEach(product => {
      var taskKey = datastore.key([keyUrl, product.attributes['data-product-id']])
      var stockLevelDom = product.querySelector('.pli-stock-level')
      var stockLevelNum = "null"
      if ( typeof( stockLevelDom ) == "object" && stockLevelDom != null ){
        stockLevelNum = stockLevelDom.text.match(/\d/g).join("")
      }else{
        console.log("Little strange on the item : " + domain + product.querySelector('a').attributes['href'] )
      }
      var thisItem = {
        'brand': product.querySelector('.ui-pl-name-brand').text,
        'name': product.querySelector('.ui-pl-name-title').text,
        'link': domain + product.querySelector('a').attributes['href'],
        'discount': product.querySelector('.discount-amount-text').text,
        'price': product.querySelector('.ui-pl-pricing-low-price').text,
        'stock': stockLevelNum,
        'update': currentTime
      }
      tasks.push(
        datastore
        .get(taskKey)
        .then(results => {
          if (results[0] == undefined) {
            thisItem.add = currentTime
            console.log(`✅ <b>${thisItem.discount} Off!</b> (${thisItem.price}) ( Stock : ${thisItem.stock} ) <a href="${thisItem.link}">${thisItem.brand} - ${thisItem.name}</a>`)
            // return true
            return bot.telegram.sendMessage(
              tgGroupId,
              `✅ <b>${thisItem.discount} Off!</b> (${thisItem.price}) ( Stock : ${thisItem.stock} ) <a href="${thisItem.link}">${thisItem.brand} - ${thisItem.name}</a>`, {
                'parse_mode': 'HTML',
                'disable_web_page_preview': true
              }
            )
          }
          return false
        }).then(() => {
          return datastore.save({
            key: taskKey,
            data: thisItem
          })
        })
        .catch(err => {
          console.error('ERROR:', err);
        })
      )
    });
    return tasks
  }
  var options = {
    url: crawlUrl,
    headers: {
      'User-Agent': 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_10_1) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/39.0.2171.95 Safari/537.36'
    }
  };
  // Return a new promise.
  return new Promise((resolve, reject) => {
    rp(options)
      .then((body) => {
        let docroot = HTMLParser.parse(body)
        return Promise.all(update_db(docroot.querySelectorAll('.ui-product-listing'), keyUrl)).then(values => {
          console.log(keyUrl + ' is updated')
          resolve()
        });
      })
      .catch((err) => { console.log(err); reject()} );
  });
}

function update_all() {
  return new Promise((resolve, reject) => {
    const query = datastore.createQuery('target');
    runPageQuery(query)
      .then(results => {
        return Promise.all(results[0].map((task) => {
          var url = queryString.parseUrl(task.url)
          url.query.pagesize = 40
          var crawlUrl = url.url + '?' + queryString.stringify(url.query)
          var options = {
            url: crawlUrl,
            headers: {
              'User-Agent': 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_10_1) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/39.0.2171.95 Safari/537.36'
            }
          };
          // Return a new promise.
          return new Promise((resolve, reject) => {
            rp(options)
              .then((body) => {
                let docroot = HTMLParser.parse(body)
                let totalPages = docroot.querySelectorAll('.pag ul li.page-number').length + 1
                taskList = []
                for (var i = 0; i < totalPages; i++) {
                  url.query.page = i
                  var returnCrawlUrl = url.url + '?' + queryString.stringify(url.query)
                  taskList.push({
                    'keyUrl': task.url,
                    'crawlUrl': returnCrawlUrl
                  })
                }
                resolve(taskList)
              })
              .catch((err) => reject());
          });
        }))
        .then((results) => {
          return [].concat.apply([], results);
        })
        .catch((err) => console.log(err))
      })
      .then(taskList => {
        return Promise.all(taskList.map(task => update_url(task.keyUrl, task.crawlUrl)))
          .then(() => resolve())
          .catch((err) => console.log(err))
      })
  });
}

async function runPageQuery(query, pageCursor) {
  if (pageCursor) {
    query = query.start(pageCursor);
  }
  const results = await datastore.runQuery(query);
  const entities = results[0];
  const info = results[1];

  if (info.moreResults !== Datastore.NO_MORE_RESULTS) {
    // If there are more results to retrieve, the end cursor is
    // automatically set on `info`. To get this value directly, access
    // the `endCursor` property.
    const results = await runPageQuery(query, info.endCursor);

    // Concatenate entities
    results[0] = entities.concat(results[0]);
    return results;
  }

  return [entities, info];
}

function check_soldOut(targetUrl) {
  let query = datastore.createQuery(targetUrl).filter('update', '<', new Date(Date.now() - 12 * 60 * 1000 * 60)).limit(20);
  return new Promise((resolve, reject) => {
    runPageQuery(query)
      .then(results => {
        // Task entities found.
        const tasks = results[0];
        var keys = []
        tasks.forEach(task => {
          // bot.telegram.sendMessage(tgGroupId, '❌ ' + task.brand + ' - ' + task.name + ' is sold out!')
          console.log(task.brand + ' - ' + task.name + ' is sold out!')
          keys.push(task[datastore.KEY])
        });
        return keys
      })
      .then(keys => {
        console.log('Cleaning up ' + targetUrl)
        if (keys.length != 0) {
          datastore.delete(keys).then(() => {
            console.log('Deleted ' + keys.length + ' records.')
            resolve()
          });
        } else {
          console.log('No record need to delete')
          resolve()
        }
      })
      .catch((err) => {
        console.log(err)
        reject()
      });
  });
}

function check_all_soldOut() {
  return new Promise((resolve, reject) => {
    const query = datastore.createQuery('target');
    runPageQuery(query)
      .then(results => {
        // Task entities found.
        const tasks = results[0];
        var taskList = []
        tasks.forEach(task => {
          taskList.push(task.url)
        });
        return taskList
      })
      .then(taskList => {
        return Promise.all(taskList.map(task => check_soldOut(task)))
          .then(() => resolve())
      })
  });
}

new CronJob('*/30 * * * * *', function() {
  update_all()
    .then(() => check_all_soldOut())
    .then(() => {
      return datastore.save({
        key: datastore.key(['options', 'update']),
        data: {
          'time': new Date()
        }
      })
    })
}, null, true, 'America/Los_Angeles');

// new CronJob('15 * * * * *', function() {
//   var taskKey = datastore.key(['options', 'update'])
//   datastore.get(taskKey).then(results => {
//     const entity = results[0];
//     console.log(entity)
//   });
// }, null, true, 'America/Los_Angeles');