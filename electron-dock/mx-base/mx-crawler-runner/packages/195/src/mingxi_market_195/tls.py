"""Use Python/system + certifi CA roots for verified Twisted HTTPS on Windows."""
import ssl
import certifi
from scrapy.core.downloader.contextfactory import BrowserLikeContextFactory
from twisted.internet.ssl import Certificate,optionsForClientTLS,trustRootFromCertificates


class VerifiedContextFactory(BrowserLikeContextFactory):
    def __init__(self,*args,**kwargs):
        super().__init__(*args,**kwargs)
        context=ssl.create_default_context()
        context.load_verify_locations(certifi.where())
        self._roots=trustRootFromCertificates([
            Certificate.loadPEM(ssl.DER_cert_to_PEM_cert(der)) for der in context.get_ca_certs(binary_form=True)
        ])

    def creatorForNetloc(self,hostname,port):
        return optionsForClientTLS(hostname=hostname.decode('ascii'),trustRoot=self._roots,
                                   extraCertificateOptions={'method':self._ssl_method})
