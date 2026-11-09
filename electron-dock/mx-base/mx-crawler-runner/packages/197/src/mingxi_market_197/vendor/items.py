import scrapy


class AppRecordItem(scrapy.Item):
    collection = scrapy.Field()
    unique_fields = scrapy.Field()
    payload = scrapy.Field()


class CrawlResultItem(scrapy.Item):
    market = scrapy.Field()
    mode = scrapy.Field()
    input_value = scrapy.Field()
    success = scrapy.Field()
    error = scrapy.Field()

