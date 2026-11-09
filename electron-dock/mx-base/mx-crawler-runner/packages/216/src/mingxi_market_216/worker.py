"""Run one Scrapy reactor in an isolated child process; no database required."""
import json
from pathlib import Path
import sys
from datetime import datetime,timezone
from itertools import islice
from scrapy import Request,signals
from scrapy.crawler import CrawlerProcess
from scrapy.exceptions import IgnoreRequest
from .config import MARKET,SOURCE_ID
from .spider import Spider as UpstreamSpider
from .vendor.models import JobConfig,RunOptions
from .vendor.items import AppRecordItem,CrawlResultItem
from .normalize import normalize


class RequestLimit:
    def __init__(self):self.count=0
    def process_request(self,request,spider):
        self.count+=1
        if self.count>spider.job_config.extra['max_requests']:
            spider.crawler.stats.set_value('delivery/request_limit',True)
            raise IgnoreRequest('Configured request limit reached')


class Spider(UpstreamSpider):
    # Scrapy 2.13 async start API; retain native request creation/parsers.
    async def start(self):
        for request in self.build_start_requests():yield request

    def parse_history_index(self,response):
        yield from islice(super().parse_history_index(response),self.job_config.extra['history_limit'])

    def parse_entry(self,response):
        history_count=0
        for item in super().parse_entry(response):
            if isinstance(item,Request) and item.meta.get('request_kind')=='history':
                history_count+=1
                if history_count>self.job_config.extra['history_limit']:continue
            yield item


def run(config):
    folder=Path(config['work_dir'])
    mode={'package':'package-list','id':'id-list','pid':'pid-list','docid':'docid-list','appid':'appid-list'}[config['input_kind']]
    if MARKET=='baidu' and config['history']:mode='history-pid-list'
    job=JobConfig(mode,tuple(config['inputs']),{'history_limit':config['history_limit'],'max_requests':config['max_requests']})
    options=RunOptions('',config['concurrency'],config['request_timeout'],'WARNING',config['history'])
    settings={'BOT_NAME':'mingxi_market_'+str(SOURCE_ID),'ITEM_PIPELINES':{},'TELNETCONSOLE_ENABLED':False,
        'CONCURRENT_REQUESTS':config['concurrency'],'CONCURRENT_REQUESTS_PER_DOMAIN':config['concurrency'],
        'DOWNLOAD_DELAY':config['delay'],'RANDOMIZE_DOWNLOAD_DELAY':False,'DOWNLOAD_TIMEOUT':config['request_timeout'],
        'DOWNLOAD_MAXSIZE':8*1024*1024,'RETRY_ENABLED':False,'ROBOTSTXT_OBEY':False,
        'DOWNLOADER_CLIENTCONTEXTFACTORY':__package__+'.tls.VerifiedContextFactory',
        'DOWNLOADER_MIDDLEWARES':{__package__+'.worker.RequestLimit':50},
        'DEPTH_LIMIT':3,'CLOSESPIDER_TIMEOUT':max(config['timeout']-3,.1),'LOG_LEVEL':'WARNING',
        'LOGSTATS_INTERVAL':0,'LOG_FILE':str(folder/'scrapy.log')}
    process=CrawlerProcess(settings);crawler=process.create_crawler(Spider)
    items=[];outcomes=[];errors=[];rejected=[];http=[]
    def on_item(item,response,spider):
        if isinstance(item,AppRecordItem):
            raw=dict(item['payload']);record=normalize(raw,response.url)
            if record:
                items.append(record)
                with (folder/'records.jsonl').open('a',encoding='utf-8') as f:f.write(json.dumps(record,ensure_ascii=False)+'\n')
            else:rejected.append({'input_value':raw.get('_meta',{}).get('input_value'),'reason':'Missing app name, identity or version'})
        elif isinstance(item,CrawlResultItem):outcomes.append(dict(item))
    def on_error(failure,response,spider):errors.append({'input_value':response.meta.get('input_value'),'message':str(failure.value)[:1000]})
    def on_response(response,request,spider):http.append({'url':response.url,'status':response.status,'input_value':request.meta.get('input_value')})
    crawler.signals.connect(on_item,signals.item_scraped)
    crawler.signals.connect(on_error,signals.spider_error)
    crawler.signals.connect(on_response,signals.response_received)
    deferred=process.crawl(crawler,job_config=job,run_options=options)
    def startup_failed(failure):errors.append({'input_value':None,'message':str(failure.value)[:1000]})
    deferred.addErrback(startup_failed)
    process.start()
    stats=crawler.stats.get_stats();reason=stats.get('finish_reason')
    failures=errors+[x for x in outcomes if not x.get('success')]
    good={x['input_value'] for x in items if x['record_type']=='detail'}
    history_good={x['input_value'] for x in items if x['record_type']=='history'}
    complete=set(config['inputs']).issubset(good)
    if config['history']:complete=complete and set(config['inputs']).issubset(history_good)
    limited=bool(stats.get('delivery/request_limit')) or reason!='finished'
    ok=complete and not failures and not rejected and not limited
    status='success' if ok else ('partial' if items else ('error' if failures or limited else 'unknown'))
    warnings=[]
    if config['history']:warnings.append('History is a bounded sample, not a complete version archive.')
    if not complete:warnings.append('Some inputs or requested history did not yield valid application records.')
    if rejected:warnings.append('Empty/error payloads were rejected instead of reported as success.')
    if limited:warnings.append('Request/time limit or abnormal shutdown prevented completion.')
    result={'source_row_id':SOURCE_ID,'provider':'halifox/app_market_crawler','platform':MARKET,
        'observed_at':datetime.now(timezone.utc).isoformat(),'status':status,
        'data':{'items':items,'outcomes':[{'input_value':value,'status':('success' if value in good and (not config['history'] or value in history_good) else ('partial' if value in good or value in history_good else 'unknown'))} for value in config['inputs']],
                'native_outcomes':outcomes,'errors':errors,'rejected':rejected,'http':http},
        'warnings':warnings,'error':None if ok else {'code':'INCOMPLETE' if items else 'NO_VALID_RECORDS','message':'Inspect outcomes, errors and rejected records'},
        'stats':{'requests':stats.get('downloader/request_count',0),'responses':stats.get('response_received_count',0),'finish_reason':reason}}
    (folder/'summary.json').write_text(json.dumps(result,ensure_ascii=False,indent=2),encoding='utf-8')


if __name__=='__main__':run(json.load(sys.stdin))
