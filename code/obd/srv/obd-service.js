const cds = require('@sap/cds');
const crypto = require('crypto');

const k8s = require('@kubernetes/client-node');
const kc = new k8s.KubeConfig();
kc.loadFromCluster();

const k8sBatchV1Api = kc.makeApiClient(k8s.BatchV1Api);
const k8sCustObjApi = kc.makeApiClient(k8s.CustomObjectsApi);

// Environment variables required to handle onboarding and to build unique tenantIds
const kymaNamespace = process.env["KYMA_NAMESPACE"];
const clusterShootname = process.env["CLUSTER_SHOOTNAME"];

// Platform IdP details to assign tenant admin the Subaccount Viewer role
const platformIdpOrigin = process.env["PLATFORMIDP_ORIGIN"];
const platformIdpUrl = process.env["PLATFORMIDP_URL"];

// Release name of SaaS app to be onboarded
const saasHelmRelease = process.env["SAAS_HELM_RELEASE"];

module.exports = cds.service.impl(async function () {

    // Called after SAP IAS authentication from Home-Screen or when user wants to access tenant from Onboarding-Screen
    this.on("login", async (req)=> {
        try {
            if (!req.user) { return req.error(404, 'Error: Missing User Details') };
            if (!req.user.attr?.scim_id) { return req.error(404, 'Error: Missing User Details') };

            const scimId = req.user.attr.scim_id;
            // Unique sha256 hash value build to identify a tenant
            const tenantId = crypto.createHash('shake256', { outputLength: 10 }).update(`${saasHelmRelease}-${kymaNamespace}-${clusterShootname}-${scimId}`).digest('hex');
            // Tenant exists if API rule for tenant exists
            const result = await k8sCustObjApi.listNamespacedCustomObject('gateway.kyma-project.io','v1beta1',kymaNamespace,'apirules','',false,'','','app.sap.com/subdomain=' + encodeURI(tenantId));

            // If no tenant exists for user, potential x-custom-host cookie deleted and user forwarded to onboarding UI
            if (!result.body.items || result.body.items?.length == 0){ 
                if (req._.req.cookies["x-custom-host"]){
                    req._.res.clearCookie("x-custom-host", { httpOnly: false })
                }
                return req._.res.redirect('/sapsusaasuionboarding/') 
            }

            // If tenant exists, check if x-custom-host cookie is set
            const cookie = req._.req.cookies ? req._.req.cookies["x-custom-host"] : undefined;

            // If cookie is not set, set new x-custom-host cookie containing the tenantId
            if (cookie === undefined) { 
                req._.res.cookie('x-custom-host', tenantId, { maxAge: 1*24*60*60*1000, httpOnly: false });
                console.log('Info: Cookie x-custom-host created successfully');
            }

            // Redirect user to SaaS application 
            req._.res.redirect('/sapsusaasuipublicflp/');

        } catch(error) {
            console.error(`Error: Error during post-login process: ${JSON.stringify(error)}`);
            return req.error(500, `Error during post-login process: ${error.message}`);
        };
    });

    // Triggered to retrieve information on available tenant of current SAP IAS user
    this.on("tenant", async (req)=> {
        try {
            if (!req.user) { return req.error(404, 'Error: Missing User Details') };
            if (!req.user.attr?.scim_id) { return req.error(404, 'Error: Missing User Details') };

            const scimId = req.user.attr.scim_id;
            const tenantId = crypto.createHash('shake256', { outputLength: 10 }).update(`${saasHelmRelease}-${kymaNamespace}-${clusterShootname}-${scimId}`).digest('hex');
            
            // If API Rule exists for tenantID, also a tenant exists
            const result = await k8sCustObjApi.listNamespacedCustomObject('gateway.kyma-project.io','v1beta1',kymaNamespace,'apirules','',false,'','','app.sap.com/subdomain=' + encodeURI(tenantId));

            // If no API Rule exists, an empty response is returned
            if (!result.body.items || result.body.items?.length == 0){ return req.reply() }

            console.log(`Tenants: ${JSON.stringify(result.body)}`);

            // Tenant subdomain and platform IdP Url returned for forwarding in Onboarding-Screen
            return req.reply({ tenantSubdomain : result.body.items[0]?.spec?.host, platformIdpUrl : platformIdpUrl });
        } catch(error) {
            console.error(`Error: Error reading tenants: ${JSON.stringify(error)}`);
            return req.error(500, `Error reading tenants: ${error.message}`);
        };
    });


    /**
     * Triggered to retrieve the potential tenant on- or offboarding process of the current SAP IAS user
     */
    this.on("status", async (req)=> {
        try{
            if (!req.user) { return req.error(404, 'Error: Missing User Details') };
            if (!req.user.attr?.scim_id) { return req.error(404, 'Error: Missing User Details')};

            const scimId = req.user.attr?.scim_id;
            const tenantId = crypto.createHash('shake256', { outputLength: 10 }).update(`${saasHelmRelease}-${kymaNamespace}-${clusterShootname}-${scimId}`).digest('hex');
            
            let onboardingStatus = null;
            let offboardingStatus = null;
            
            // Check if either an onboarding or offboarding process is running
            try{ onboardingStatus = await k8sBatchV1Api.readNamespacedJobStatus(tenantId + '-onboard', kymaNamespace) }catch(error){ console.log(`No onboarding process running`) }
            try{ offboardingStatus = await k8sBatchV1Api.readNamespacedJobStatus(tenantId + '-offboard', kymaNamespace) }catch(error){ console.log(`No offboarding process running`) }

            // If no process is running, return null
            if( !onboardingStatus && !offboardingStatus ){
                console.log(`No onboarding or offboarding job running!`);
                return req.reply({ process: null });
            // Return details of the status currently running (on- or offboarding)
            }else{
                const jobStatus = onboardingStatus ?? offboardingStatus;
                console.log(`Status: ${JSON.stringify(jobStatus)}`);
                return req.reply({ process: onboardingStatus ? 'onboarding' : 'offboarding' });
            }
        } catch (error) {
            console.error(`Error: Status of Job could not be retrieved: ${JSON.stringify(error)}`)
            return req.error(500, `Status of Job could not be retrieved: ${error.message}`);
        }
    });

    /**
     * Triggered when an SAP IAS user chooses to onboard a new tenant from the Onboarding-Screen
     */
    this.on("onboardTenant", async (req)=> {
        try{
            if (!req.user) { return req.error(404, 'Error: Missing User Details') };
            if (!req.user.attr?.scim_id) { return req.error(404, 'Error: Missing User Details') };

            const scimId = req.user.attr?.scim_id;
            const tenantId = crypto.createHash('shake256', { outputLength: 10 }).update(`${saasHelmRelease}-${kymaNamespace}-${clusterShootname}-${scimId}`).digest('hex');

            console.log("Info: Tenant Id - " + tenantId);
            console.log("Info: Tenant Subdomain - " + encodeURI(tenantId));

            // Check whether tenant already exists
            console.log("Info: Check if tenant for user already exists")
            const tenantResult = await k8sCustObjApi.listNamespacedCustomObject('gateway.kyma-project.io','v1beta1',kymaNamespace,'apirules','',false,'','','app.sap.com/subdomain=' + encodeURI(tenantId));
            
            // If tenant already exists for authenticated SAP IAS user, an error message is returned
            if (tenantResult.body.items && tenantResult.body.items?.length > 0){ 
                console.error(`Error: Error during tenant onboarding: Tenant for user already exists!`)
                return req.error(404, `Error occurred during tenant onboarding:  Tenant for user already exists!`)
            }

            console.log("Info: Start tenant onboarding")

            // Define the platform IDP origin name if set in Kyma Secret, otherwise use sap.custom
            const idp = platformIdpOrigin ?? 'sap.custom';

            // Define reusable names for the SaaS API Service instances and bindings
            const serviceInstanceName = saasHelmRelease + `-api-` + kymaNamespace + `-` + clusterShootname;
            const serviceBindingName = saasHelmRelease + `-api-` + kymaNamespace + `-` + clusterShootname;

            // Trigger a new Kubernetes Job spinning up SAP BTP Setup Automator to onboard the tenant Subaccount
            // - SAP IAS trust setup and additional configuration has to be done in a separate bash command 
            // - Service bindings and instances have to be created after the subscription process has finished
            // - Authenticated SAP IAS user is assigned the Subaccount Viewer and SaaS Administrator role 
            const jobResult = await k8sBatchV1Api.createNamespacedJob(kymaNamespace, {
                apiVersion: 'batch/v1',
                kind: 'Job',
                metadata: { name: tenantId + '-onboard' },
                spec: {
                    ttlSecondsAfterFinished: 10,
                    template: {
                        metadata: { name: tenantId + '-onboard', annotations: { "sidecar.istio.io/inject": "false" } },
                        spec: {
                            restartPolicy: 'Never',
                            containers: [{
                                image: 'ghcr.io/sap-samples/btp-setup-automator:btpsa-v1.8.1',
                                name: 'btpsa',
                                env: [
                                    { name: 'MYEMAIL', valueFrom: { secretKeyRef: { name: 'btp-credentials', key: 'email'} } },
                                    { name: 'MYPASSWORD', valueFrom: { secretKeyRef: { name: 'btp-credentials', key: 'password' } } },
                                    { name: 'GLOBALACCOUNT', valueFrom: { secretKeyRef: { name: 'btp-credentials', key: 'globalaccount' } } },
                                    { name: 'PROVSUBACCOUNT', valueFrom: { secretKeyRef: { name: 'btp-credentials', key: 'provsubaccount' } } },
                                    { name: 'IASHOST', valueFrom: { secretKeyRef: { name: 'btp-credentials', key: 'iashost' } } },
                                    { name: 'ADMINS', valueFrom: { secretKeyRef: { name: 'btp-credentials', key: 'admins' } } }
                                ],
                                command: [
                                    "/bin/sh", 
                                    "-ec",
                                    `echo '{ 
                                            "services": [ { 
                                                "name": "` + saasHelmRelease + '-' + kymaNamespace + '-' + clusterShootname + `", 
                                                "category": "APPLICATION", 
                                                "plan": "trial", 
                                                "targetenvironment": "sapbtp", 
                                                "customerDeveloped": true, 
                                                "requiredrolecollections": [ { "name": "Susaas Administrator (` + saasHelmRelease + '-' + kymaNamespace + `)", "assignedUserGroupsFromParameterFile": [ "SusaaS_Admins" ], "idp": "sap.custom" } ] 
                                            }], 
                                            "assignrolecollections": [ 
                                                { "name": "Subaccount Viewer", "type": "account", "level": "sub account", "assignedUserGroupsFromParameterFile": [ "SusaaS_Admins" ], "idp": "` + idp  + `" },
                                                { "name": "Subaccount Administrator", "type": "account", "level": "sub account", "assignedUserGroupsFromParameterFile": [ "admins" ], "idp": "sap.default" }, 
                                                { "name": "Subaccount Service Administrator", "type": "account", "level": "sub account", "assignedUserGroupsFromParameterFile": [ "admins" ], "idp": "sap.default" }
                                            ], 
                                            "executeAfterAccountSetup": [  
                                                {  "description": "Setup SAP IAS trust", "command": "btp create security/trust --idp $(IASHOST) --subaccount $(jq -r '.subaccountid' ./log/metadata_log.json) --name sap-ias "  }, 
                                                {  "description": "Disable Shadow User Creation", "command": "btp update security/trust sap.custom --subaccount $(jq -r '.subaccountid' ./log/metadata_log.json) --auto-create-shadow-users false "  }, 
                                                {  "description": "Disable SAP IdP Login", "command": "btp update security/trust sap.default --subaccount $(jq -r '.subaccountid' ./log/metadata_log.json) --available-for-user-logon false "  },
                                                {  "description": "Create API Service Instance", "command": "btp create services/instance --subaccount $(jq -r '.subaccountid' ./log/metadata_log.json) --offering-name '`+ serviceInstanceName + `' --service '` + serviceInstanceName + `' --plan-name 'trial' " },
                                                {  "description": "Create API Service Binding", "command": "btp create services/binding --subaccount $(jq -r '.subaccountid' ./log/metadata_log.json) --instance-name '`+ serviceInstanceName + `' --binding '` + serviceBindingName + `' " }
                                            ]  
                                        }' > 'obdusecase.json' \
                                    && echo '{ 
                                            "region": "us20", 
                                            "subaccountname": "`+ tenantId + `", 
                                            "subdomain": "`+ encodeURI(tenantId) + `", 
                                            "defaultIdp": "sap.custom", 
                                            "subaccountlabels": { "scimId": ["`+ scimId + `"], "createdOn": ["`+ new Date().toJSON().slice(0, 10) + `"] }, 
                                            "loginmethod": "basicAuthentication", 
                                            "skipcfspacecreation": true, 
                                            "customAppProviderSubaccountId": "$(PROVSUBACCOUNT)", 
                                            "myusergroups": [ { "name": "SusaaS_Admins", "members": [ "` + req.user.id + `" ] }, { "name": "admins", "members": [ $(ADMINS) ] } ] 
                                        }' > 'obdparameters.json' \
                                    && ./btpsa \
                                        -usecasefile 'obdusecase.json' \
                                        -parameterfile 'obdparameters.json' \
                                        -globalaccount '$(GLOBALACCOUNT)' \
                                        -mypassword '$(MYPASSWORD)' \
                                        -myemail '$(MYEMAIL)' \
                                        -iashost '$(IASHOST)' \
                                        -defaultIdp 'sap.custom'`
                                ]
                            }]
                        }
                    }
                }
            });

            console.log(`Onboarding: ${JSON.stringify(jobResult.body)}`);
            return req.reply('Onboarding Started');
        } catch (error) {
            console.error(`Error: Error during tenant onboarding: ${JSON.stringify(error)}`)
            return req.error(404, `Error occurred during tenant onboarding: ${error.message}`)
        }
    });

    /**
     * Triggered when an SAP IAS user chooses to offboard a tenant from the Onboarding-Screen
     */
    this.on("offboardTenant", async (req)=> {
        try{
            if (!req.user) { return req.error(404, 'Error: Missing User Details') };
            if (!req.user.attr?.scim_id) { return req.error(404, 'Error: Missing User Details') };

            const scimId = req.user.attr?.scim_id;
            const tenantId = crypto.createHash('shake256', { outputLength: 10 }).update(`${saasHelmRelease}-${kymaNamespace}-${clusterShootname}-${scimId}`).digest('hex');
            
            console.log("Info: Tenant Id - " + tenantId);
            console.log("Info: Tenant Subdomain - " + encodeURI(tenantId));

            // Check whether tenant already exists
            console.log("Info: Check if tenant for user exists")
            const tenantResult = await k8sCustObjApi.listNamespacedCustomObject('gateway.kyma-project.io','v1beta1',kymaNamespace,'apirules','',false,'','','app.sap.com/subdomain=' + encodeURI(tenantId));
            
            // If no tenant for the authenticated SAP IAS user exists, return an error
            if (tenantResult.body.items && tenantResult.body.items?.length === 0){ 
                console.error(`Error: Error during tenant offboarding: Tenant for user does not exists!`)
                return req.error(404, `Error occurred during tenant offboarding: Tenant for user does not exist!`)
            }

            console.log("Info: Start tenant offboarding")

            // Define some reused names for the SaaS API Service instances and bindings
            const serviceInstanceName = saasHelmRelease + `-api-` + kymaNamespace + `-` + clusterShootname;
            const serviceBindingName = saasHelmRelease + `-api-` + kymaNamespace + `-` + clusterShootname;

            // Trigger a new Kubernetes Job spinning up SAP BTP Setup Automator to offboard the tenant Subaccount
            // Service bindings and instances have to be deleted before pruning the subaccount and subscription
            // Deleting the subscription will remove the service broker registration and prevent a service deletion
            const jobResult = await k8sBatchV1Api.createNamespacedJob(kymaNamespace, {
                apiVersion: 'batch/v1',
                kind: 'Job',
                metadata: { name: tenantId + '-offboard' },
                spec: {
                    ttlSecondsAfterFinished: 10,
                    template: {
                        metadata: { name: tenantId + '-offboard', annotations: { "sidecar.istio.io/inject": "false" } },
                        spec: {
                            restartPolicy: 'Never',
                            containers: [{
                                image: 'ghcr.io/sap-samples/btp-setup-automator:btpsa-v1.8.1',
                                name: 'btpsa',
                                env: [
                                    { name: 'MYEMAIL', valueFrom: { secretKeyRef: { name: 'btp-credentials', key: 'email'} } },
                                    { name: 'MYPASSWORD', valueFrom: { secretKeyRef: { name: 'btp-credentials', key: 'password' } } },
                                    { name: 'GLOBALACCOUNT', valueFrom: { secretKeyRef: { name: 'btp-credentials', key: 'globalaccount' } } },
                                    { name: 'IASHOST', valueFrom: { secretKeyRef: { name: 'btp-credentials', key: 'iashost' } } }
                                ],
                                command: [
                                    "/bin/sh", 
                                    "-ec",
                                    `echo '{ 
                                        "executeAfterAccountSetup": [
                                            { "description": "Delete API Service Binding", "command": "btp delete services/binding --subaccount $(jq -r '.subaccountid' ./log/metadata_log.json) --name '`+ serviceBindingName + `' --confirm " },
                                            { "description": "Delete API Service Instance", "command": "btp delete services/instance --subaccount $(jq -r '.subaccountid' ./log/metadata_log.json) --name '`+ serviceInstanceName + `' --confirm " }
                                        ]
                                    }' > 'ofbdusecase.json' \
                                    && echo '{ 
                                            "region": "us20", 
                                            "subaccountname": "`+ tenantId + `", 
                                            "subdomain": "`+ encodeURI(tenantId) + `", 
                                            "loginmethod": "basicAuthentication", 
                                            "skipcfspacecreation": true, 
                                            "prunesubaccount": true
                                        }' > 'ofbdparameters.json' \
                                    && ./btpsa \
                                        -usecasefile 'ofbdusecase.json' \
                                        -parameterfile 'ofbdparameters.json' \
                                        -globalaccount '$(GLOBALACCOUNT)' \
                                        -mypassword '$(MYPASSWORD)' \
                                        -myemail '$(MYEMAIL)' \
                                        -iashost '$(IASHOST)' \
                                        -defaultIdp 'sap.custom'`
                                ]
                            }]
                        }
                    }
                }
            });

            console.log(`Offboarding: ${JSON.stringify(jobResult.body)}`);
            return req.reply('Offboarding Started');

        } catch (error) {
            console.error(`Error: Error during tenant offboarding: ${JSON.stringify(error)}`)
            return req.error(404, `Error occured during tenant offboarding: ${error.message}`)
        }
    });
});