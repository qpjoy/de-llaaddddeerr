# Plugins are baked in rather than installed at boot: a controller that reaches
# out to the update centre on every start is a controller that behaves
# differently depending on when it was restarted.
FROM jenkins/jenkins:2.504.3-lts-jdk21

USER root
# git is needed by the controller itself for lightweight checkouts of pipeline
# definitions; builds get their own tools inside agent pods.
RUN apt-get update \
 && apt-get install -y --no-install-recommends git ca-certificates \
 && rm -rf /var/lib/apt/lists/*
USER jenkins

COPY plugins.txt /usr/share/jenkins/ref/plugins.txt
RUN jenkins-plugin-cli --plugin-file /usr/share/jenkins/ref/plugins.txt --latest false

# Skip the setup wizard: configuration comes from JCasC, and a wizard waiting
# for a browser is how a headless deploy hangs forever.
ENV JAVA_OPTS="-Djenkins.install.runSetupWizard=false -Dhudson.model.DirectoryBrowserSupport.CSP="
ENV CASC_JENKINS_CONFIG=/var/jenkins_config/casc.yaml
